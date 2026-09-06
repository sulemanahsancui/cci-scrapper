/** Pause execution for a random duration within [min, max] ms. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomSleep(min = 500, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}
