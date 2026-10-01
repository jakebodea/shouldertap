/**
 * Unlocking an inbox is one purchase. It costs less while the inbox is still
 * in its free trial, to reward deciding while it's fresh. Amounts in US cents.
 */
export const TRIAL_PRICE_CENTS = 500;
export const FULL_PRICE_CENTS = 1000;

/** "$5", "$10", "$4.99": whole dollars without cents. */
export const formatPrice = (cents: number) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
