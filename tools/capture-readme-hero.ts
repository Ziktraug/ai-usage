import { mkdir } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { DEMO_HOST, DEMO_PORT } from './run-web-demo';

const VIEWPORT = { height: 900, width: 1600 } as const;
const MAX_HERO_BYTES = 1024 * 1024;
const SERVER_START_TIMEOUT_MS = 120_000;
const SERVER_STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const TOP_SESSION_PATTERN = /Top session/;

const rootDirectory = path.resolve(import.meta.dirname, '..');
const heroPath = path.join(rootDirectory, 'docs', 'assets', 'ai-usage-overview-session-detail.png');
const demoUrl = `http://${DEMO_HOST}:${DEMO_PORT}`;

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

const portIsListening = async (): Promise<boolean> =>
  await new Promise<boolean>((resolve) => {
    const socket = connect({ host: DEMO_HOST, port: DEMO_PORT });
    const finish = (listening: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

const waitForDemo = async (child: Bun.Subprocess): Promise<void> => {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Demo process exited before capture with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(demoUrl, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The loopback server is still starting.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Demo did not start on ${demoUrl} within ${SERVER_START_TIMEOUT_MS}ms.`);
};

const waitForProcessExit = async (child: Bun.Subprocess): Promise<boolean> => {
  await child.exited;
  return true;
};

const waitForStopTimeout = async (): Promise<boolean> => {
  await delay(SERVER_STOP_TIMEOUT_MS);
  return false;
};

const stopDemo = async (child: Bun.Subprocess): Promise<void> => {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const stopped = await Promise.race([waitForProcessExit(child), waitForStopTimeout()]);
    if (!stopped && child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }

  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await portIsListening())) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Demo port ${DEMO_HOST}:${DEMO_PORT} remained open after capture.`);
};

const assertCaptureContent = async (page: Page): Promise<void> => {
  await page.getByText('Demo data', { exact: true }).waitFor({ state: 'visible' });
  const overview = page.getByRole('tab', { name: 'Overview' });
  await overview.waitFor({ state: 'visible' });
  if ((await overview.getAttribute('aria-selected')) !== 'true') {
    throw new Error('Overview was not selected before hero capture.');
  }
  await page.getByText('API-equivalent value', { exact: true }).first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: TOP_SESSION_PATTERN }).click();
  const drawer = page.getByRole('dialog', { name: 'Session details' });
  await drawer.waitFor({ state: 'visible' });
  const drawerTitle = drawer.getByText('Build report UI', { exact: true }).first();
  await drawerTitle.waitFor({ state: 'visible' });
  const valueRegion = page.getByRole('region', { name: 'API-equivalent value' });
  await valueRegion.waitFor({ state: 'visible' });
  await valueRegion.evaluate((element) => {
    const captureInset = 80;
    window.scrollTo({
      left: 0,
      top: Math.max(0, window.scrollY + element.getBoundingClientRect().top - captureInset),
    });
  });
  const [valueRegionBox, drawerTitleBox] = await Promise.all([valueRegion.boundingBox(), drawerTitle.boundingBox()]);
  if (!(valueRegionBox && valueRegionBox.y >= 0 && valueRegionBox.y < VIEWPORT.height)) {
    throw new Error('The Overview value proposition was outside the hero viewport.');
  }
  if (!(drawerTitleBox && drawerTitleBox.y >= 0 && drawerTitleBox.y < VIEWPORT.height)) {
    throw new Error('The selected session title was outside the hero viewport.');
  }
  await page.evaluate(
    async () =>
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.evaluate(async () => await document.fonts.ready);
};

const validateHero = async (): Promise<void> => {
  const hero = Bun.file(heroPath);
  if (hero.size >= MAX_HERO_BYTES) {
    throw new Error(`Hero is ${hero.size} bytes; expected fewer than ${MAX_HERO_BYTES}.`);
  }
  const bytes = new Uint8Array(await hero.arrayBuffer());
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Hero output is not a PNG.');
  }
  const dimensions = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dimensions.getUint32(16);
  const height = dimensions.getUint32(20);
  if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
    throw new Error(`Hero is ${width}×${height}; expected ${VIEWPORT.width}×${VIEWPORT.height}.`);
  }
};

if (await portIsListening()) {
  throw new Error(`Refusing to capture while ${DEMO_HOST}:${DEMO_PORT} is already in use.`);
}

const demo = Bun.spawn(['bun', '--no-env-file', 'run', 'demo'], {
  cwd: rootDirectory,
  env: { PATH: process.env.PATH ?? '' },
  stderr: 'inherit',
  stdout: 'inherit',
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await waitForDemo(demo);
  const executablePath = Reflect.get(process.env, 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH');
  browser = await chromium.launch(typeof executablePath === 'string' ? { executablePath } : undefined);
  const context = await browser.newContext({
    colorScheme: 'light',
    deviceScaleFactor: 1,
    locale: 'en-US',
    reducedMotion: 'reduce',
    timezoneId: 'Europe/Paris',
    viewport: VIEWPORT,
  });
  const page = await context.newPage();
  const businessRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.resourceType() === 'fetch' ||
      request.resourceType() === 'xhr' ||
      request.resourceType() === 'eventsource'
    ) {
      businessRequests.push(`${request.resourceType()}:${request.url()}`);
    }
  });
  await page.goto(demoUrl, { waitUntil: 'networkidle' });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;caret-color:transparent!important;transition-delay:0s!important;transition-duration:0s!important}',
  });
  await assertCaptureContent(page);
  if (businessRequests.length > 0) {
    throw new Error(`Demo made business requests during capture: ${businessRequests.join(', ')}`);
  }
  await mkdir(path.dirname(heroPath), { recursive: true });
  await page.screenshot({ path: heroPath });
  await validateHero();
} finally {
  await browser?.close();
  await stopDemo(demo);
}

console.info(`Captured ${path.relative(rootDirectory, heroPath)} from ${demoUrl}.`);
