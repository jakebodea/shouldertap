import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { personColors, swatches } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";

import { frameStyle } from "@/lib/frame";

/** A miniature of the overlay a tap arrives in, framed in a person's color. */
export const MiniTap = ({
  color,
  name,
  message = "Can you come here?",
}: {
  color: PersonColor;
  name: string;
  message?: string;
}) => (
  <div
    aria-hidden="true"
    className="bg-frame text-frame-ink relative rounded-2xl px-2 pt-[1.6rem] pb-2 transition-colors duration-500"
    style={frameStyle(color)}
  >
    <div className="absolute top-[0.4rem] left-3.5 flex gap-1.5 text-[0.6875rem]">
      <span className="max-w-40 truncate font-bold">{name}</span>
      <span className="opacity-75">just now</span>
    </div>
    <div className="bg-paper text-ink rounded-[0.625rem] px-4 pt-[1.125rem] pb-3.5">
      <p className="mb-3 text-2xl leading-none font-extrabold tracking-[-0.035em]">
        {message}
      </p>
      <div className="flex gap-1.5">
        <i className="bg-frame h-4 w-10 rounded-full" />
        <i className="h-4 w-10 rounded-full shadow-[inset_0_0_0_1px_var(--line)]" />
        <i className="h-4 w-10 rounded-full shadow-[inset_0_0_0_1px_var(--line)]" />
      </div>
    </div>
  </div>
);

/** The eight person colors as swatches; one is always chosen. */
export const ColorPicker = ({
  value,
  onChange,
  legend = "Your color",
}: {
  value: PersonColor;
  onChange: (color: PersonColor) => void;
  legend?: string;
}) => (
  <fieldset>
    <legend className="mb-2 block text-sm font-bold">{legend}</legend>
    <div className="grid max-w-[24rem] grid-cols-8 gap-2">
      {personColors.map((option) => (
        <label
          className="has-[:focus-visible]:outline-ink relative grid aspect-square w-full cursor-pointer place-items-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)] has-[:checked]:shadow-[0_0_0_2px_var(--paper),0_0_0_4px_var(--ink)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4"
          key={option}
          style={{
            background: swatches[option].base,
            color: swatches[option].ink,
          }}
        >
          <input
            aria-label={swatches[option].label}
            checked={value === option}
            className="peer sr-only"
            name="color"
            onChange={() => {
              onChange(option);
            }}
            type="radio"
            value={option}
          />
          <HugeiconsIcon
            className="size-5 opacity-0 transition-opacity peer-checked:opacity-100"
            icon={Tick02Icon}
            strokeWidth={2}
          />
        </label>
      ))}
    </div>
  </fieldset>
);
