import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { env } from '../config/env';
import { type Job, cleanMultiline, cleanText, extractSalary, meetsSalaryFloor } from './parser';

const BASE_URL = 'https://www.linkedin.com';
const PAGE_SIZE = 25;

/** LinkedIn `f_E` experience-level codes. LinkedIn has no separate "Mid-Level"; mid and senior share "Mid-Senior level". */
export const EXPERIENCE_LEVEL = {
  internship: '1',
  entry: '2',
  associate: '3',
  midSenior: '4',
  director: '5',
  executive: '6',
} as const;

/** LinkedIn `f_SB2` salary buckets: minimum annual salary -> code. */
const SALARY_BUCKETS: Array<[number, string]> = [
  [200_000, '9'],
  [180_000, '8'],
  [160_000, '7'],
  [140_000, '6'],
  [120_000, '5'],
  [100_000, '4'],
  [80_000, '3'],
  [60_000, '2'],
  [40_000, '1'],
];

const POSTED_WITHIN = { day: 'r86400', week: 'r604800', month: 'r2592000' } as const;

export interface LinkedInSearchOptions {
  keywords?: string;
  location?: string;
  /** LinkedIn geo id; 90000097 = "Washington DC-Baltimore Area". */
  geoId?: string;
  experience?: string[];
  minSalary?: number;
  postedWithin?: keyof typeof POSTED_WITHIN;
  maxPages?: number;
  maxJobs?: number;
  headless?: boolean;
}

const DEFAULTS: Required<Omit<LinkedInSearchOptions, 'postedWithin'>> = {
  keywords: 'engineer',
  location: 'Washington DC-Baltimore Area',
  geoId: '90000097',
  experience: [EXPERIENCE_LEVEL.associate, EXPERIENCE_LEVEL.midSenior],
  minSalary: 200_000,
  maxPages: 1,
  maxJobs: 25,
  headless: env.headless,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 2-3 second jittered pause between requests. */
const politeDelay = () => sleep(2000 + Math.random() * 1000);

const log = (...args: unknown[]) => console.error('[linkedin]', ...args);

export function buildSearchUrl(opts: LinkedInSearchOptions, start = 0): string {
  const o = { ...DEFAULTS, ...opts };
  const params = new URLSearchParams({
    keywords: o.keywords,
    location: o.location,
    geoId: o.geoId,
    f_E: o.experience.join(','),
    sortBy: 'DD',
  });
  const bucket = SALARY_BUCKETS.find(([floor]) => o.minSalary >= floor);
  if (bucket) params.set('f_SB2', bucket[1]);
  if (opts.postedWithin) params.set('f_TPR', POSTED_WITHIN[opts.postedWithin]);
  if (start > 0) params.set('start', String(start));
  return `${BASE_URL}/jobs/search/?${params}`;
}

async function ensureLoggedIn(page: Page, headless: boolean): Promise<void> {
  // The browser profile persists, so a previous session is often still valid.
  await page.goto(`${BASE_URL}/feed/`, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname.startsWith('/feed')) {
    log('Reusing existing session');
    return;
  }

  log('Logging in');
  await politeDelay();
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username');
  await page.type('#username', env.linkedin.email, { delay: 40 });
  await page.type('#password', env.linkedin.password, { delay: 40 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);

  if (/checkpoint|challenge/.test(page.url())) {
    if (headless) {
      throw new Error(
        'LinkedIn requires a security check. Run once with HEADLESS=false (or --headful), ' +
          'solve it in the browser window, and the session will be saved for headless runs.',
      );
    }
    log('Security checkpoint detected - solve it in the browser window (waiting up to 3 minutes)');
    await page.waitForFunction(() => location.pathname.startsWith('/feed'), { timeout: 180_000 });
  }

  if (/\/login|\/uas\//.test(page.url())) {
    throw new Error('LinkedIn login failed - check LINKEDIN_EMAIL / LINKEDIN_PASSWORD.');
  }
  log('Logged in');
}

/** Scroll the results pane so lazily rendered cards load. */
async function scrollResults(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const card = document.querySelector('[data-occludable-job-id], [data-job-id]');
    let pane: HTMLElement | null = card?.parentElement ?? null;
    while (pane && !(pane.scrollHeight > pane.clientHeight && /auto|scroll/.test(getComputedStyle(pane).overflowY))) {
      pane = pane.parentElement;
    }
    const target = pane ?? document.scrollingElement ?? document.body;
    for (let y = 0; y < target.scrollHeight; y += 400) {
      target.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 250));
    }
  });
}

async function collectJobIds(page: Page, url: string): Promise<string[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const found = await page
    .waitForSelector('[data-occludable-job-id], [data-job-id], a[href*="/jobs/view/"]', { timeout: 15_000 })
    .catch(() => null);
  if (!found) return [];

  await scrollResults(page);

  const ids = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('[data-occludable-job-id], [data-job-id]').forEach((el) => {
      const id = el.getAttribute('data-occludable-job-id') ?? el.getAttribute('data-job-id');
      if (id) out.push(id);
    });
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]').forEach((a) => {
      const m = a.href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/);
      if (m) out.push(m[1]);
    });
    return out;
  });
  return [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
}

interface RawJobDetail {
  title: string | null;
  company: string | null;
  location: string | null;
  salaryText: string | null;
  description: string | null;
}

async function scrapeJobDetail(page: Page, id: string): Promise<Job | null> {
  const url = `${BASE_URL}/jobs/view/${id}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 15_000 }).catch(() => null);

  // Expand the truncated description if there's a "See more" button.
  await page
    .$eval('button.jobs-description__footer-button, button[aria-label*="see more" i]', (b) => (b as HTMLElement).click())
    .catch(() => undefined);

  // Selectors cover both the logged-in layout and the public/guest layout, newest first.
  const raw: RawJobDetail = await page.evaluate(() => {
    const pick = (selectors: string[], inner = false): string | null => {
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        const text = (inner ? el?.innerText : el?.textContent)?.trim();
        if (text) return text;
      }
      return null;
    };
    return {
      title: pick([
        '.job-details-jobs-unified-top-card__job-title h1',
        '.jobs-unified-top-card__job-title',
        '.top-card-layout__title',
        'h1',
      ]),
      company: pick([
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
      ]),
      location: pick([
        '.job-details-jobs-unified-top-card__tertiary-description-container',
        '.job-details-jobs-unified-top-card__primary-description-container',
        '.jobs-unified-top-card__bullet',
        '.topcard__flavor--bullet',
      ]),
      salaryText: pick([
        '#SALARY',
        '.job-details-fit-level-preferences',
        '.job-details-jobs-unified-top-card__job-insight',
        '.salary-main-rail__data-body',
        '.compensation__salary',
      ]),
      description: pick(
        ['#job-details', '.jobs-description__content', '.jobs-box__html-content', '.show-more-less-html__markup'],
        true,
      ),
    };
  });

  if (!raw.title) {
    log(`Skipping ${id}: could not read job details (layout change or auth wall?)`);
    return null;
  }

  const description = cleanMultiline(raw.description);
  // Prefer LinkedIn's structured salary; fall back to a salary mentioned in the description.
  const salary = extractSalary(raw.salaryText) ?? extractSalary(description);

  return {
    id,
    source: 'linkedin',
    title: cleanText(raw.title),
    company: cleanText(raw.company),
    // Top-card text looks like "Washington, DC · 3 days ago · 120 applicants".
    location: cleanText(raw.location?.split('·')[0]),
    salary: salary?.raw ?? null,
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    url,
    description,
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Log in to LinkedIn, run a job search, and return normalized jobs.
 * Jobs whose listed salary tops out below `minSalary` are dropped; jobs with no listed salary are kept.
 */
export async function scrapeLinkedIn(options: LinkedInSearchOptions = {}): Promise<Job[]> {
  const opts = { ...DEFAULTS, ...options };
  const browser = await puppeteer.launch({
    headless: opts.headless,
    userDataDir: path.join(env.dataDir, '.chrome-profile'),
    defaultViewport: { width: 1366, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await ensureLoggedIn(page, opts.headless);

    const ids: string[] = [];
    for (let p = 0; p < opts.maxPages && ids.length < opts.maxJobs; p++) {
      await politeDelay();
      const url = buildSearchUrl(opts, p * PAGE_SIZE);
      log(`Search page ${p + 1}: ${url}`);
      const pageIds = (await collectJobIds(page, url)).filter((id) => !ids.includes(id));
      log(`  found ${pageIds.length} jobs`);
      if (pageIds.length === 0) break;
      ids.push(...pageIds);
    }

    const jobs: Job[] = [];
    for (const [i, id] of ids.slice(0, opts.maxJobs).entries()) {
      await politeDelay();
      try {
        const job = await scrapeJobDetail(page, id);
        if (!job) continue;
        if (!meetsSalaryFloor(job, opts.minSalary)) {
          log(`  [${i + 1}] dropped (salary ${job.salary}): ${job.title} @ ${job.company}`);
          continue;
        }
        log(`  [${i + 1}] ${job.title} @ ${job.company}${job.salary ? ` (${job.salary})` : ''}`);
        jobs.push(job);
      } catch (err) {
        log(`  [${i + 1}] failed to scrape ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    return jobs;
  } finally {
    await browser.close();
  }
}
