export type JobSource = 'linkedin' | 'indeed';

export interface Job {
  id: string;
  source: JobSource;
  title: string;
  company: string;
  location: string;
  /** Salary text as shown on the posting, e.g. "$180K/yr - $220K/yr". */
  salary: string | null;
  /** Annualized salary bounds in USD, parsed from `salary`. */
  salaryMin: number | null;
  salaryMax: number | null;
  url: string;
  description: string;
  scrapedAt: string;
}

const HOURS_PER_YEAR = 2080;

/** Collapse all whitespace to single spaces. */
export function cleanText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Trim each line and collapse runs of blank lines, preserving paragraph breaks. */
export function cleanMultiline(s: string | null | undefined): string {
  return (s ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MONEY = String.raw`\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?`;
const PERIOD = String.raw`(?:yr|year|hr|hour|annum)`;
const SALARY_RE = new RegExp(
  `${MONEY}(?:\\s*/\\s*${PERIOD})?(?:\\s*(?:-|–|—|to)\\s*${MONEY})?(?:\\s*(?:/|per|an?)\\s*${PERIOD})?`,
  'gi',
);

function toAmount(num: string, k: string | undefined): number {
  return parseFloat(num.replace(/,/g, '')) * (k ? 1000 : 1);
}

export interface ParsedSalary {
  raw: string;
  min: number;
  max: number;
}

/**
 * Find the first plausible salary in free text and annualize it.
 * Handles "$180K/yr - $220K/yr", "$150,000.00 - $200,000.00 a year", "$95/hr", "$200k+".
 */
export function extractSalary(text: string | null | undefined): ParsedSalary | null {
  if (!text) return null;
  for (const match of text.matchAll(SALARY_RE)) {
    const raw = cleanText(match[0]);
    const amounts = [...raw.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kK])?/g)].map((m) => toAmount(m[1], m[2]));
    if (amounts.length === 0) continue;

    const hourly = /hr|hour/i.test(raw);
    const annual = amounts.map((a) => Math.round(hourly ? a * HOURS_PER_YEAR : a));
    const min = Math.min(...annual);
    const max = Math.max(...annual);

    // Skip things like "$50 gift card" or "$5M Series A" that aren't salaries.
    if (max < 20_000 || min > 2_000_000) continue;
    return { raw, min, max };
  }
  return null;
}

/** Jobs with no listed salary pass; listed salaries must reach the floor at the top of the range. */
export function meetsSalaryFloor(job: Pick<Job, 'salaryMax'>, floor: number): boolean {
  return job.salaryMax === null || job.salaryMax >= floor;
}
