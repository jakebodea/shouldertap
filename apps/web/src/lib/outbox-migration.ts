/** Keep previously refused messages failed: resending an old tap needs the
 * sender's intent. Retire the persisted billing banner without dropping drafts. */
export const migrateBillingRefusal = <
  T extends { paused?: boolean; failed: boolean; error?: string },
>(
  item: T
): T =>
  item.paused
    ? {
        ...item,
        paused: false,
        failed: true,
        error: "This message wasn't sent. Try again when you're ready.",
      }
    : item;
