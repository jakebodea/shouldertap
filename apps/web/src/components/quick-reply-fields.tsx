import { MAX_QUICK_REPLY_LENGTH } from "@shouldertap/domain";

/**
 * The two one-tap answers a tap offers, as editable fields. The number on each
 * is the key that answers with it on a computer.
 */
export const QuickReplyFields = ({
  id,
  replies,
  onChange,
}: {
  id: string;
  replies: readonly [string, string];
  onChange: (replies: [string, string]) => void;
}) => (
  <div className="grid grid-cols-2 gap-2">
    {replies.map((reply, index) => (
      <label className="relative block" key={`${id}-${String(index)}`}>
        <span className="sr-only">Reply option {index + 1}</span>
        <span
          aria-hidden="true"
          className="text-tone pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[0.8125rem] font-bold tabular-nums"
        >
          {index + 1}
        </span>
        <input
          className="field py-3 pl-8 text-[0.9375rem] font-semibold"
          maxLength={MAX_QUICK_REPLY_LENGTH}
          onChange={(event) => {
            const next: [string, string] = [replies[0], replies[1]];
            next[index] = event.target.value;
            onChange(next);
          }}
          value={reply}
        />
      </label>
    ))}
  </div>
);
