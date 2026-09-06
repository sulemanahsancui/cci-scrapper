export default {
  browser: {
    headless: true,
    slowMo: 0,
    devtools: false,
  },
  scraper: {
    concurrency: 50,
    delayMin: 200,
    delayMax: 1500,
    retries: 7,
  },
  queue: {
    concurrency: 50,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
};
