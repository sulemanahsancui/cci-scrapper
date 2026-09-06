export default {
  browser: {
    headless: true,
    slowMo: 0,
    devtools: false,
  },
  scraper: {
    concurrency: 10,
    delayMin: 500,
    delayMax: 2000,
    retries: 5,
  },
  queue: {
    concurrency: 10,
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
};
