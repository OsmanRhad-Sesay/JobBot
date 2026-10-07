import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

// Credentials are read lazily so a missing Indeed/SMTP var doesn't break the LinkedIn scraper.
export const env = {
  linkedin: {
    get email() {
      return required('LINKEDIN_EMAIL');
    },
    get password() {
      return required('LINKEDIN_PASSWORD');
    },
  },
  headless: process.env.HEADLESS !== 'false',
  dataDir: path.resolve(__dirname, '../../data'),
};
