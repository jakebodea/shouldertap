import { useEffect, useRef, useState } from "react";

/** Frames are downscaled to this many pixels on their long side to decode. */
const DECODE_SIZE = 640;

const loadJsQr = () => import("jsqr");

const cameraError = (caught: unknown) =>
  caught instanceof DOMException && caught.name === "NotAllowedError"
    ? "Camera access is off. Allow it in Settings, or paste the link instead."
    : "Couldn't open the camera. Paste the link instead.";

/**
 * A live camera view that decodes QR codes. `onScan` gets each decoded
 * value and returns true to accept it, which stops the camera.
 */
export const QrScanner = ({
  onScan,
}: {
  onScan: (value: string) => boolean;
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | undefined;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem(
          "This browser can't use the camera. Paste the link instead."
        );
        return;
      }
      try {
        const [{ default: jsQR }, media] = await Promise.all([
          loadJsQr(),
          navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: "environment" },
          }),
        ]);
        stream = media;
        const video = videoRef.current;
        if (stopped || !video || !context) {
          return;
        }
        video.srcObject = media;
        await video.play();

        const tick = () => {
          if (stopped) {
            return;
          }
          if (video.readyState >= video.HAVE_ENOUGH_DATA) {
            const scale = Math.min(
              1,
              DECODE_SIZE / Math.max(video.videoWidth, video.videoHeight)
            );
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height
            );
            const code = jsQR(image.data, image.width, image.height);
            if (code && onScanRef.current(code.data)) {
              return;
            }
          }
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch (error) {
        if (!stopped) {
          setProblem(cameraError(error));
        }
      }
    };
    start();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, []);

  if (problem) {
    return (
      <p className="bg-faint rounded-2xl px-4 py-3 text-[0.9375rem] leading-snug">
        {problem}
      </p>
    );
  }

  return (
    <div className="bg-ink relative aspect-square w-full overflow-hidden rounded-2xl">
      <video
        aria-label="Camera view for scanning the invite QR code"
        className="size-full object-cover"
        muted
        playsInline
        ref={videoRef}
      />
      <div
        aria-hidden="true"
        className="absolute inset-[18%] rounded-2xl shadow-[0_0_0_2px_rgb(255_255_255/0.85),0_0_0_100vmax_rgb(0_0_0/0.35)]"
      />
    </div>
  );
};
