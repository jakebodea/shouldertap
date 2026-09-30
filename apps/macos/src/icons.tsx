// Deep imports: the package index re-exports thousands of icons, and Metro
// bundles everything an index touches.
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import BubbleChatIcon from "@hugeicons/core-free-icons/BubbleChatIcon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import SentIcon from "@hugeicons/core-free-icons/SentIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import UserAdd01Icon from "@hugeicons/core-free-icons/UserAdd01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import type { TapResponse } from "@shouldertap/domain";
import Svg, { Path } from "react-native-svg";

/** The standard glyphs (DESIGN.md, "Icons"). */
export const icons = {
  onIt: Tick02Icon,
  in10: Clock01Icon,
  reply: BubbleChatIcon,
  send: SentIcon,
  back: ArrowLeft01Icon,
  invite: UserAdd01Icon,
  mac: ComputerIcon,
  addMac: Link01Icon,
  remove: Delete02Icon,
  copy: Copy01Icon,
};

export type IconName = keyof typeof icons;

/** Hugeicons stroke glyph; `color` must be a plain color string. */
export function Icon({
  name,
  size = 20,
  color,
}: {
  name: IconName;
  size?: number;
  color: string;
}) {
  return (
    <HugeiconsIcon
      color={color}
      icon={icons[name]}
      size={size}
      strokeWidth={1.5}
    />
  );
}

export const responseIcon = (response: TapResponse): IconName => {
  switch (response.kind) {
    case "on_it":
      return "onIt";
    case "in_10":
      return "in10";
    default:
      return "reply";
  }
};

/** The Shouldertap mark (DESIGN.md, "The mark"). */
export function Mark({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      fill="none"
      height={size}
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      // The design viewBox, widened so the top knock's round cap isn't clipped.
      viewBox="-3.5 -11.525 46.025 46.025"
      width={size}
    >
      <Path
        d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z"
        strokeWidth={5}
      />
      <Path d="M26.8 -3.08L29.19 -9.65" strokeWidth={3.75} />
      <Path d="M30.63 -0.63L35.58 -5.58" strokeWidth={3.75} />
      <Path d="M33.08 3.2L39.65 0.81" strokeWidth={3.75} />
    </Svg>
  );
}
