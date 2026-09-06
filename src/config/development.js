export default {
  browser: {
    headless: false,
    slowMo: 50,
    devtools: true,
  },
  scraper: {
    concurrency: 2,
    delayMin: 1000,
    delayMax: 3000,
    retries: 3,
  },
  queue: {
    concurrency: 2,
    removeOnComplete: 100,
    removeOnFail: 200,
  },
};
