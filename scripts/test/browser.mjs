// Drives the web application in a real browser against a real sshd.
//
// This is acceptance test item 4 without a person: open the page, paste a key,
// connect, get a shell, type a command, resize, send Ctrl-C.
//
// Usage: node browser.mjs <pageUrl> <sshHost> <sshPort> <user> <keyfile>
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [pageUrl, sshHost, sshPort, user, keyFile] = process.argv.slice(2);
if (!pageUrl || !sshHost || !sshPort || !user || !keyFile) {
  console.error('Usage: node browser.mjs <pageUrl> <sshHost> <sshPort> <user> <keyfile>');
  process.exit(1);
}

const failures = [];
function check(name, ok) {
  console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch();
const page = await browser.newPage();

// A Content Security Policy violation or a Trusted Types error arrives here.
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(message.text());
});
page.on('pageerror', (error) => problems.push(String(error)));

/** The visible text of the terminal. */
const terminalText = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.xterm-rows > div'))
      .map((row) => row.textContent)
      .join('\n'),
  );

async function waitForTerminal(want, count, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const text = await terminalText();
    if (text.split(want).length - 1 >= count) return text;
    if (Date.now() > deadline) {
      throw new Error(`${want} did not appear ${count} times. The terminal held:\n${text}`);
    }
    await page.waitForTimeout(250);
  }
}

try {
  await page.goto(pageUrl, { waitUntil: 'networkidle' });

  check('the page loads and React renders the form', await page.isVisible('#host'));
  check('xterm.js draws the terminal', await page.isVisible('.xterm-rows'));
  check(
    'the page reports the relay transport',
    (await page.textContent('.transport'))?.includes('relay') ?? false,
  );

  await page.fill('#host', sshHost);
  await page.fill('#port', sshPort);
  await page.fill('#user', user);
  await page.fill('#key', readFileSync(keyFile, 'utf8'));
  await page.click('button:has-text("Connect")');

  // The host key dialog must appear before the shell opens.
  await page.waitForSelector('.dialog code', { timeout: 30_000 });
  const fingerprint = (await page.textContent('.dialog code')) ?? '';
  check('the host key fingerprint is shown', fingerprint.startsWith('SHA256:'));
  await page.click('button:has-text("Accept")');

  await page.waitForSelector('.status.ok', { timeout: 30_000 });
  check('the shell opens', (await page.textContent('.status'))?.includes('Connected') ?? false);

  // xterm.js takes keyboard input through a hidden textarea. A click on the
  // rows is intercepted by the screen element, so focus the textarea instead.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo ok\n');
  await waitForTerminal('ok', 2, 20);
  check('echo ok returns ok', true);

  await page.keyboard.type('echo $((6*7))\n');
  await waitForTerminal('42', 1, 20);
  check('the remote shell runs commands', true);

  // A smaller window changes the number of columns, and the application tells
  // the remote host.
  await page.setViewportSize({ width: 700, height: 480 });
  await page.waitForTimeout(700);
  await page.keyboard.type('stty size\n');
  const size = await waitForTerminal('\n', 1, 20).then(() => terminalText());
  const cols = await page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length);
  check('the terminal still draws after a resize', cols > 0 && size.length > 0);

  await page.keyboard.type('sleep 300\n');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(500);
  await page.keyboard.type('echo BACK\n');
  await waitForTerminal('BACK', 2, 20);
  check('Ctrl-C reaches the remote shell', true);

  check(`no console error (${problems.length} found)`, problems.length === 0);
  if (problems.length > 0) {
    for (const problem of problems.slice(0, 8)) console.log(`      ${problem}`);
  }
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  if (problems.length > 0) {
    console.error('Console errors:');
    for (const problem of problems.slice(0, 8)) console.error(`  ${problem}`);
  }
  failures.push('the run did not finish');
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nThe web application works in a browser.');
