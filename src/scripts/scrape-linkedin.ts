import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { env } from '../config/env';
import { scrapeLinkedIn } from '../scrapers/linkedin';

const program = new Command()
  .name('scrape-linkedin')
  .description('Scrape LinkedIn for engineering roles and print them as JSON')
  .option('-k, --keywords <text>', 'search keywords', 'engineer')
  .option('-p, --pages <n>', 'search result pages to read (25 jobs each)', '1')
  .option('-m, --max <n>', 'max jobs to open and scrape', '25')
  .option('--posted <window>', 'only jobs posted within: day | week | month')
  .option('--headful', 'show the browser window (needed to solve a login checkpoint)')
  .option('-o, --out <file>', 'output file', path.join(env.dataDir, 'linkedin-jobs.json'))
  .parse();

async function main() {
  const opts = program.opts();
  const jobs = await scrapeLinkedIn({
    keywords: opts.keywords,
    maxPages: Number(opts.pages),
    maxJobs: Number(opts.max),
    postedWithin: opts.posted,
    headless: opts.headful ? false : env.headless,
  });

  const json = JSON.stringify(jobs, null, 2);
  fs.writeFileSync(opts.out, json);
  console.log(json);
  console.error(`\nScraped ${jobs.length} jobs -> ${opts.out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
