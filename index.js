// This is a launcher tool for the game Cataclysm: Dark Days Ahead.

import 'zx/globals'
import enquirer from "enquirer";
import { createWriteStream, default as fsSync } from 'fs';
import { join } from "path";
import { homedir, tmpdir } from "os";
import { oraPromise, default as ora } from "ora";
import colors from "ansi-colors";
import { formatDistanceToNow } from "date-fns";
import fromAsync from 'array-from-async';

$.verbose = false

// TODO: Use ~/Library/Caches on macOS?
const cacheDir = join(homedir(), ".cache", "cdda-launcher");
const releasesFile = join(cacheDir, "releases.json");

await fs.mkdir(cacheDir, { recursive: true });

async function maybeFetch(url, options) {
  const response = await fetch(url, options);
  if (response.ok) return response;
  throw new Error(`HTTP ${response.status} ${response.statusText}`);
}

function getReleases() {
  return maybeFetch("https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases")
    .then(r => r.json())
}

function getLatestRelease() {
  return maybeFetch("https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases/latest")
    .then(r => r.json())
}

async function getAllReleases() {
  const [releases, latestRelease] = await Promise.all([
    getReleases(),
    getLatestRelease()
  ])
  return [latestRelease, ...releases]
}

async function updateReleases() {
  const allReleases = await getAllReleases();
  await fs.writeFile(releasesFile, JSON.stringify(allReleases, null, 2));
  return allReleases;
}

let fetched = false;
let releases = [];

try {
  releases = await fs
    .readFile(releasesFile, "utf8")
    .then((contents) => JSON.parse(contents));
} catch (e) {
  await oraPromise(updateReleases(), {
    text: "Fetching releases",
    successText: (releases) => `Fetched ${releases.length} releases`,
  });
  fetched = true
}

async function* getCachedReleases() {
  for (const version of await fs.readdir(cacheDir).catch(() => [])) {
    try {
      const releaseFile = join(cacheDir, version, "release.json");
      const contents = await fs.readFile(releaseFile, "utf8");
      yield JSON.parse(contents);
    } catch {
      continue;
    }
  }
}

const stableReleases = releases.filter((release) => !release.prerelease);
if (!stableReleases.length) throw new Error("No stable releases found");
const latestStableRelease = stableReleases[0];
const cachedReleases = await fromAsync(getCachedReleases());

function isCached(version) {
  return cachedReleases.some((release) => release.tag_name === version);
}

const settingsFile = join(cacheDir, "settings.json");
const settings = await fs.readJson(settingsFile).catch(() => ({}));

const assetMatch = {
  darwin: /osx-tiles/,
  linux: /linux-tiles-sounds/,
  win32: /windows-tiles-sounds-x64/,
}[process.platform]

// Latest experimental release with an asset matching the current platform.
let experimentalRelease = releases
  .find((release) => release.prerelease && release.assets.some((asset) => assetMatch.test(asset.name)));

const lastVersion = isCached(settings.lastVersion) ? settings.lastVersion : null;

const choices = [
  {
    name: `Stable (${latestStableRelease.tag_name})`,
    value: latestStableRelease,
    hint: isCached(latestStableRelease.tag_name) ? `(cached)` : null
  },
  {
    name: `Latest Experimental`,
    value: null,
    disabled: true,
    hint() {
      const relativeTime = formatDistanceToNow(new Date(experimentalRelease.published_at), { addSuffix: true })
      return fetched ? `(${relativeTime})` : "(fetching...)"
    }
  },
  ...cachedReleases
    .sort(((a, b) => new Date(b.published_at) - new Date(a.published_at)))
    .filter((release) => release.tag_name !== latestStableRelease.tag_name)
    .map((release) => ({
      name: release.tag_name,
      value: release,
      hint: `(cached)`
    })),
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
      await oraPromise(fs.rm(join(cacheDir, selected.tag_name), { recursive: true }), {
        text: `Deleting ${selected.tag_name}...`,
        successText: `Deleted ${selected.tag_name}`,
        failText: `Failed to delete ${selected.tag_name}`
      })
    } else {
      console.log('😌 Okay, it can stay.')
    }
  }
});

if (!fetched)
  updateReleases().then((newReleases) => {
    if (prompt.state.submitted) return
    fetched = true
    releases = newReleases
    experimentalRelease = releases
      .find((release) => release.prerelease && release.assets.some((asset) => assetMatch.test(asset.name)));
    const e = prompt.choices.find(c => c.name === 'Latest Experimental')
    e.name = e.message = `Latest Experimental (${experimentalRelease.tag_name})`
    e.value = experimentalRelease
    e.disabled = false
    prompt.render()
  }).catch((e) => {
    if (prompt.state.submitted) return
    // fail silently
    fetched = true
    prompt.render()
  })

try {
  await prompt.run();
  const chosenRelease = prompt.choices[prompt.index].value

  // If the version isn't cached, download it.
  if (!isCached(chosenRelease.tag_name))
    await downloadRelease(chosenRelease);

  if (chosenRelease.tag_name !== lastVersion)
    await fs.writeFile(settingsFile, JSON.stringify({ lastVersion: chosenRelease.tag_name }, null, 2));

  const gameDir = join(cacheDir, chosenRelease.tag_name);

  const launchSpinner = ora("Launching...").start();
  if (process.platform === 'darwin') {
    await $`open ${join(gameDir, 'Cataclysm.app')} --args ${process.argv.slice(2)}`
    launchSpinner.stopAndPersist({ symbol: '🧟‍♂️', text: 'Launched!' })
  }
} catch {
}

async function downloadAsset(tmpDir, asset) {
  const url = asset.browser_download_url;

  const assetResponse = await fetch(url)
  const dest = join(tmpDir, asset.name)
  const writeStream = assetResponse.body.pipe(createWriteStream(dest))
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve)
    writeStream.on('error', reject)
  })
  return dest
}

async function downloadRelease(release) {
  const tmpDir = await fs.mkdtemp(join(tmpdir(), "cdda-launcher-download-"));
  process.on("exit", () => {
    fsSync.rmdirSync(tmpDir, { recursive: true })
  });

  const asset = release.assets.find((asset) => assetMatch.test(asset.name));
  const assetFile = await oraPromise(downloadAsset(tmpDir, asset), {
    text: `Downloading ${release.tag_name} (${(asset.size / 1024 / 1024).toPrecision(3)} MiB)...`,
    successText: `Downloaded ${release.tag_name}`,
  });

  // Extract the downloaded archive.
  const extractSpinner = ora("Extracting archive...").start();

  if (process.platform === 'darwin') {
    const mountInfo = await $`hdiutil attach ${assetFile} -mountrandom ${tmpDir} -plist`;
    const mountPoint = mountInfo.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)[1];
    await fs.mkdir(join(cacheDir, release.tag_name), { recursive: true });
    await fs.copy(join(mountPoint, 'Cataclysm.app'), join(cacheDir, release.tag_name, 'Cataclysm.app'));
    await $`hdiutil detach ${mountPoint}`;
  }

  // Write the release JSON to the cache directory.
  await fs.writeFile(join(cacheDir, release.tag_name, "release.json"), JSON.stringify(release, null, 2));

  extractSpinner.succeed(`Extracted ${release.tag_name} to ${join(cacheDir, release.tag_name)}`);
}
