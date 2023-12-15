// This is a launcher tool for the game Cataclysm: Dark Days Ahead.

import 'zx/globals'
import enquirer from "enquirer";
import { promises as fs } from "fs";
import { createWriteStream, default as fsSync } from 'fs';
import { join } from "path";
import { homedir, tmpdir } from "os";
import ora from "ora";
import chalk from "chalk";
import colors from "ansi-colors";
import { formatDistanceToNow } from "date-fns";

$.verbose = false

// This is the cache directory where we'll store the various versions
// of the game.
// TODO: Use ~/Library/Caches on macOS?
const cacheDir = join(homedir(), ".cache", "cdda-launcher");

// Create the cache directory if it doesn't exist.
await fs.mkdir(cacheDir, { recursive: true });

function maybeFetch(url, options) {
  return fetch(url, options).then((response) => {
    if (response.ok) return response;
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  });
}

// Get all the releases from the GitHub API. Use a generator to
// paginate through all the results. Use the link header to get the
// URL for the next page.
async function getReleases() {
  return maybeFetch("https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases?per_page=100").then(r => r.json())
}

async function getLatestRelease() {
  return maybeFetch("https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases/latest").then(r => r.json())
}

// Use a file called `releases.json` in the cache directory to store
// the list of releases.
const releasesFile = join(cacheDir, "releases.json");

async function updateReleases() {
  const [releases, latestRelease] = await Promise.all([
    getReleases(),
    getLatestRelease()
  ])
  const allReleases = [latestRelease, ...releases]
  await fs.writeFile(releasesFile, JSON.stringify(allReleases, null, 2));
  return allReleases;
}
let fetched = false;

if (!await fs.stat(releasesFile).catch(() => null)) {
  const spinner = ora("Fetching releases").start();
  const releases = await updateReleases();
  spinner.succeed(`Fetched ${releases.length} releases`);
  fetched = true
}

let releases = await fs
  .readFile(releasesFile, "utf8")
  .then((contents) => JSON.parse(contents));

const stableReleases = releases.filter((release) => !release.prerelease);
const experimentalReleases = releases.filter((release) => release.prerelease);

// Get the list of files in the cache directory.
const cacheDirContents = await fs.readdir(cacheDir).catch(() => []);

// Filter to just directories.
const cachedVersions = await Promise.all(
  cacheDirContents.map(async (file) => {
    const stat = await fs.stat(join(cacheDir, file));
    return stat.isDirectory() ? file : null;
  })
).then((files) => files.filter(Boolean));

const cachedReleases = await Promise.all(
  cachedVersions.map(async (version) => {
    const releaseFile = join(cacheDir, version, "release.json");
    return fs
      .readFile(releaseFile, "utf8")
      .then((contents) => JSON.parse(contents))
      .catch(() => null);
  })
).then((releases) => releases.filter(Boolean));

// Use a file called settings.json in the cache directory to store
// the last version the user selected.
const settingsFile = join(cacheDir, "settings.json");
const settings = await fs
  .readFile(settingsFile, "utf8")
  .then((contents) => JSON.parse(contents))
  .catch(() => ({}));

const assetMatch = {
  darwin: /osx-tiles/,
  linux: /linux-tiles-sounds/,
  win32: /windows-tiles-sounds-x64/,
}[process.platform]

// Latest experimental release with an asset matching the current platform.
const experimentalRelease = experimentalReleases.find((release) => release.assets.some((asset) => assetMatch.test(asset.name)));

const lastVersion = cachedVersions.includes(settings.lastVersion) ? settings.lastVersion : null;

const byDate = (a, b) => new Date(b.published_at) - new Date(a.published_at)

const choices = [
  { name: `Stable (${stableReleases[0].tag_name})`, value: stableReleases[0], hint: cachedVersions.includes(stableReleases[0].tag_name) ? chalk.dim(`(cached)`) : null },
  {
    name: `Latest Experimental (${experimentalRelease.tag_name})`,
    value: experimentalRelease,
    hint() {
      return fetched ? chalk.dim(`(${formatDistanceToNow(new Date(experimentalRelease.published_at), {addSuffix: true})})`) : chalk.dim("(fetching...)")
    }
  },
  ...cachedReleases.sort(byDate).map((release) => ({
    name: release.tag_name,
    value: release,
    hint: chalk.dim(`(cached)`)
  })).filter((release) => release.value.tag_name !== stableReleases[0].tag_name),
]

if (cachedReleases.length > 0)
  console.log(`${colors.bold("Shift+D")} to delete a cached version.`)

const prompt = new enquirer.Select({
  name: "version",
  message: "Which version would you like to play?",
  choices,
  initial: lastVersion,
  actions: {
    shift: {
      d: 'delete',
    }
  },
  async delete() {
    const selected = this.choices[this.index].value
    await this.cancel()
    // Delete the cached version. Confirm first.
    const confirm = await new enquirer.Confirm({
      name: "confirm",
      message: `Delete ${selected.tag_name}?`,
      initial: false,
    }).run()

    if (confirm) {
      await fs.rm(join(cacheDir, selected.tag_name), { recursive: true })
      this.choices = this.choices.filter((choice) => choice.value.tag_name !== selected.tag_name)
      this.render()
    }
  }
});

if (!fetched)
  updateReleases().then((newReleases) => {
    if (prompt.state.submitted) return
    fetched = true
    releases = newReleases
    prompt.render()
  }).catch(() => {
    if (prompt.state.submitted) return
    // fail silently
    fetched = true
    prompt.render()
  })

// Run the prompt and get the version the user selected.
try {
  await prompt.run();
  const chosenRelease = prompt.choices[prompt.index].value

  // If the version isn't cached, download it.
  if (!cachedVersions.includes(chosenRelease.tag_name)) {
    const asset = chosenRelease.assets.find((asset) => assetMatch.test(asset.name));
    const downloadSpinner = ora(`Downloading ${chosenRelease.tag_name} (${(asset.size / 1024 / 1024).toPrecision(3)} MiB)`).start();
    const url = asset.browser_download_url;
    // Create a temporary directory to download the asset to.
    // Use the system's temporary directory.
    const tmpDir = await fs.mkdtemp(join(tmpdir(), "cdda-launcher-download-"));

    // Clean up the temporary directory on process exit.
    process.on("exit", () => {
      fsSync.rmdirSync(tmpDir, { recursive: true })
    });

    const writeStream = await fetch(url)
      .then((response) => response.body.pipe(createWriteStream(join(tmpDir, asset.name))))
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve)
      writeStream.on('error', reject)
    })
    downloadSpinner.succeed(`Downloaded ${chosenRelease.tag_name}`);

    // Extract the downloaded archive.
    const extractSpinner = ora("Extracting archive").start();

    if (process.platform === 'darwin') {
      const mountInfo = await $`hdiutil attach ${join(tmpDir, asset.name)} -mountrandom ${tmpDir} -plist`;
      const mountPoint = mountInfo.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)[1];
      await fs.mkdir(join(cacheDir, chosenRelease.tag_name), { recursive: true });
      await $`cp -R ${join(mountPoint, 'Cataclysm.app')} ${join(cacheDir, chosenRelease.tag_name)}`;
      await $`hdiutil detach ${mountPoint}`;
    }

    // Write the release JSON to the cache directory.
    await fs.writeFile(join(cacheDir, chosenRelease.tag_name, "release.json"), JSON.stringify(chosenRelease, null, 2));

    extractSpinner.succeed(`Extracted ${chosenRelease.tag_name} to ${join(cacheDir, chosenRelease.tag_name)}`);
  }

  if (chosenRelease.tag_name !== lastVersion) {
    await fs.writeFile(settingsFile, JSON.stringify({ lastVersion: chosenRelease.tag_name }, null, 2));
  }

  // Run the game.
  const gameDir = join(cacheDir, chosenRelease.tag_name);

  const launchSpinner = ora("Launching...").start();
  if (process.platform === 'darwin') {
    await $`open ${join(gameDir, 'Cataclysm.app')}`
    launchSpinner.stopAndPersist({ symbol: '🧟‍♂️', text: 'Launched!' })
  }
} catch {
}
