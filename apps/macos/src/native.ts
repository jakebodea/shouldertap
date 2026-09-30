import { NativeEventEmitter, NativeModules } from "react-native";

interface ShouldertapNativeModule {
  closePopover: () => void;
  copyToClipboard: (text: string) => void;
  deleteSecret: (key: string) => Promise<boolean>;
  deviceName: () => Promise<string>;
  getItem: (key: string) => Promise<string | null>;
  getSecret: (key: string) => Promise<string | null>;
  hideOverlay: () => void;
  launchAtLogin: () => Promise<boolean>;
  openPopover: () => void;
  qrCode: (text: string) => Promise<string>;
  quit: () => void;
  setItem: (key: string, value: string | null) => void;
  setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
  setPending: (pending: boolean) => void;
  setSecret: (key: string, value: string) => Promise<boolean>;
  showOverlay: (payload: object) => void;
}

export const native =
  NativeModules.ShouldertapNative as ShouldertapNativeModule;

const emitter = new NativeEventEmitter(NativeModules.ShouldertapNative);

export const onNativeEvent = (
  name: "wake" | "popover",
  listener: (body: unknown) => void
) => emitter.addListener(name, listener);
