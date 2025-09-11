#!/usr/bin/env node

import { addGLQuoteCols } from 'tsv-quote-converters';
import AdmZip from 'adm-zip';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { execSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const getGitInfo = () => {
  try {
    const remoteUrl = execSync('git remote get-url origin 2>/dev/null').toString().trim();
    const ownerRepo = remoteUrl.match(/[\/:]([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    let dcsUrl = remoteUrl.match(/(https*:\/\/[^\/]+)/)
      ? remoteUrl.match(/(https*:\/\/[^\/]+)/)[1]
      : remoteUrl.match(/@(.*?):/)
        ? `https://${remoteUrl.match(/@(.*?):/)[1]}`
        : null;
    if (dcsUrl.includes('https://github.com')) {
      dcsUrl = dcsUrl.replace('github.com', 'git.door43.org');
    }
    const ref = execSync('git symbolic-ref -q --short HEAD || git describe --tags --exact-match 2>/dev/null || git rev-parse --abbrev-ref HEAD').toString().trim();

    return {
      owner: ownerRepo ? ownerRepo[1] : null,
      repo: ownerRepo ? ownerRepo[2] : null,
      ref,
      dcsUrl,
    };
  } catch (error) {
    return { owner: null, repo: null, ref: null, dcsUrl: null };
  }
};

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 [options]')
  .options({
    w: {
      alias: 'workingdir',
      describe: 'Directory where the TSV files are located. (default:  current directory.)',
      type: 'string',
    },
    owner: {
      describe: 'Repository owner. (default:  current checkedout repository owner or "unfoldingWord")',
      type: 'string',
    },
    repo: {
      describe: 'Repository name. (default:  current checkedout repository or the name of the current directory)',
      type: 'string',
    },
    ref: {
      describe: 'Git reference (branch/tag). (default:  Current checkedout branch or tag, or "master")',
      type: 'string',
    },
    bible: {
      describe: 'Bible link to use for the GL quotes, e.g. unfoldingWord/en_ult/v84. (default:  {owner}/en_ult/{ref})',
      type: 'string',
    },
    dcs: {
      describe: 'DCS URL. (default:  https://git.door43.org)',
      type: 'string',
    },
    'artifacts-base-url': {
      describe: 'Base URL for artifacts API (e.g., https://qa.door43.org or https://git.door43.org). Defaults to QA.',
      type: 'string',
      default: 'https://qa.door43.org',
    },
    o: {
      alias: 'output',
      describe: "Output zip file's path. (default:  {workingdir}/{repo}_{ref}_with_gl_quotes.zip)",
      type: 'string',
    },
    q: {
      alias: 'quiet',
      describe: 'Suppress ALL output, even simple info lines. (default: false)',
      type: 'boolean',
      default: false,
    },
    v: {
      alias: 'verbose',
      describe: 'Enable verbose output. Will output everything being aligned. (default: false)',
      type: 'boolean',
      default: false,
    },
    debug: {
      describe: 'Enable debug output. Shows artifact discovery/zip details and per-book cache vs generation counts.',
      type: 'boolean',
      default: false,
    },
    e: {
      alias: 'exit-on-error',
      describe: 'Exit on error. If there are any errors with the TSV file or loading a Bible book, the script should stop instantly and not make a zip file. (default: false)',
      type: 'boolean',
      default: false,
    },
    zip: {
      describe: 'Create a zip file with processed TSV files. If not specified, TSV files are overwritten in place.',
      type: 'boolean',
      default: false,
    },
    tsv: {
      describe: 'Write TSV files back to disk (used with --zip to do both zip and TSV output).',
      type: 'boolean',
      default: false,
    },
    'tsv-suffix': {
      describe: 'Suffix to add to TSV filenames before .tsv extension (e.g., "_gl_quotes" creates twl_GEN_gl_quotes.tsv).',
      type: 'string',
    },
    'rerender': {
      describe: 'Regenerate all GL Quotes for the TSV files.',
      type: 'boolean',
      default: false,
    }
  })
  .epilogue(
    'Priority for parameters:\n' +
    '1. Command line arguments\n' +
    '2. GitHub Actions environment variables\n' +
    '3. Git repository information\n\n' +
    'Output behavior:\n' +
    '- Default: Overwrite original TSV files with GL quotes added\n' +
    '- --zip: Create zip file instead of overwriting TSV files\n' +
    '- --zip --tsv: Create both zip file and overwrite TSV files\n' +
    '- --tsv-suffix="_gl_quotes": Add suffix to TSV filenames (e.g., twl_GEN_gl_quotes.tsv)\n\n' +
    'If no output zip path is specified with --zip, it will be: <repo>_<ref>_with_gl_quotes.zip'
  ).argv; const log = (...args) => {
    if (!argv.quiet || argv.verbose) console.log(...args);
  };
const dlog = (...args) => {
  if (argv.debug && !argv.quiet) console.log(...args);
};

const workingdir = argv.workingdir || process.cwd();
const currentDir = process.cwd();
process.chdir(workingdir);
// Get info from different sources
const gitInfo = getGitInfo();
process.chdir(currentDir);
const ghOwner = process.env.GITHUB_REPOSITORY?.split('/')[0];
const ghRepo = process.env.GITHUB_REPOSITORY?.split('/')[1];

// Prioritize sources
const owner = argv.owner || ghOwner || gitInfo.owner || 'unfoldingWord';
const repo = argv.repo || ghRepo || gitInfo.repo || path.basename(process.cwd()) || 'unknown';
const ref = argv.ref || process.env.GITHUB_REF_NAME || gitInfo.ref || 'master';
const dcsUrl = argv.dcs || process.env.GITHUB_SERVER_URL || gitInfo.dcsUrl || 'https://git.door43.org';
const targetBibleLink =
  argv.bible ||
  process.env.BIBLE_LINK ||
  getTargetBibleLink() ||
  (owner === 'unfoldingWord' ? `${owner}/${repo.split('_')[0]}_ult/master` : `${owner}/${repo.split('_')[0]}_glt/master`);

// Support both --rerender and --regenerate (back-compat)
const regenerateAll = argv['regenerate'] || argv['rerender'];

// Normalize artifacts base URL (strip trailing slashes)
const artifactsBaseUrl = (argv['artifacts-base-url'] || 'https://qa.door43.org').replace(/\/+$/, '');

log('owner:', owner, 'repo:', repo, 'ref:', ref, 'dcsUrl:', dcsUrl, 'targetBibleLink:', targetBibleLink);
if (!owner || !repo || !ref || !dcsUrl) {
  console.error('Error: Missing required parameters. Use --help for usage information.');
  process.exit(1);
}

const zipFilePath = argv.output || `${repo}_${ref}_with_gl_quotes.zip`;

log('Using the following settings:\n');
log(`Working directory: ${workingdir}`);
log(`Owner: ${owner}`);
log(`Repo: ${repo}`);
log(`Ref: ${ref}`);
log(`TargetBibleLink: ${targetBibleLink}`);
log(`DCS URL: ${dcsUrl}`);
log('Quiet mode:', argv.quiet);
log('Verbose mode:', argv.verbose);
log('Exit on error:', argv.exitOnError);
log('Create zip file:', argv.zip);
log('Write TSV files:', !argv.zip || argv.tsv);
log('TSV suffix:', argv['tsv-suffix'] || 'none');
if (argv.zip) {
  log(`Output zip file path: ${zipFilePath}`);
}

function getTargetBibleLink() {
  // Get manifest
  const manifestPath = path.join('manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  const relationText = manifest.dublin_core.relation;

  // Convert to array if it's a string
  const relations = Array.isArray(relationText) ? relationText : [relationText];

  let targetBible = null;
  // Find the first matching Bible
  for (const relation of relations) {
    if (relation.includes('/glt')) {
      targetBible = relation;
      break;
    }
  }
  if (!targetBible) {
    for (const relation of relations) {
      if (relation.includes('/gst')) {
        targetBible = relation;
        break;
      }
    }
  }
  if (!targetBible) {
    for (const relation of relations) {
      if (relation.includes('/ult')) {
        targetBible = relation;
        break;
      }
    }
  }
  if (!targetBible) {
    const excludeRelations = ['/ugnt', '/uhb', '/ta', '/tn', '/twl', '/tw', '/obs', '/obs-tn', '/obs-twl', '/sn', '/sq', '/tq'];
    for (const relation of relations) {
      if (!excludeRelations.some((r) => relation.includes(r))) {
        targetBible = relation;
        break;
      }
    }
  }

  if (!targetBible) {
    throw new Error('manifest.yaml relation does not contain a Bible to use');
  }

  let bibleLink = `${owner}/${targetBible.replace('/', '_').replace('?v=', '/v')}`;

  if (bibleLink.split('/').length === 2) {
    bibleLink += '/master';
  }

  log('Using Bible Link:', bibleLink);

  return bibleLink;
}

function writeErrorsToFile(errors) {
  if (!errors || errors.length === 0) {
    return;
  }

  try {
    const errorData = {
      timestamp: new Date().toISOString(),
      errors: errors
    };

    // Use current working directory since we may have changed directories
    const errorFilePath = path.join(process.cwd(), 'errors.json');

    // Ensure the directory exists
    const errorDir = path.dirname(errorFilePath);
    if (!fs.existsSync(errorDir)) {
      fs.mkdirSync(errorDir, { recursive: true });
    }

    fs.writeFileSync(errorFilePath, JSON.stringify(errorData, null, 2), 'utf8');

    if (!argv.quiet) {
      console.log(`Errors written to ${errorFilePath}`);
    }
  } catch (error) {
    console.error('Failed to write errors to file:', error.message);
  }
}

/**
 * Downloads and extracts previous GL quotes from the specified zip file
 * @param {string} fileName - The TSV filename to extract from the zip
 * @returns {Promise<string|null>} - The content of the TSV file or null if not found
 */
async function getPreviousGLQuotes(fileName, repo) {
  try {
    // cache the downloaded/loaded zip for the lifetime of this Node process
    const cache = globalThis.__previousGLZipCache || (globalThis.__previousGLZipCache = {
      zipUrl: null,
      artifactMeta: null,
      zip: null,
      zipPromise: null,
      urlPromise: null
    });

    async function fetchArtifactZipUrl(ownerName, repoName) {
      // Discover latest artifact on QA that ends with _with_gl_quotes.zip
      try {
        const listUrl = `${artifactsBaseUrl}/api/v1/repos/${ownerName}/${repoName}/actions/artifacts`;
        dlog(`Artifacts API: ${listUrl}`);
        const res = await fetch(listUrl);
        if (!res.ok) {
          throw new Error(`Failed to list artifacts: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
        // Pick the newest artifact by highest id or latest created_at
        const candidates = artifacts.filter(a =>
          typeof a?.name === 'string' &&
          a.name.endsWith('_with_gl_quotes.zip') &&
          a?.archive_download_url &&
          a?.expired === false
        );
        const match = candidates.reduce((best, cur) => {
          if (!best) return cur;
          const bestId = typeof best.id === 'number' ? best.id : -1;
          const curId = typeof cur.id === 'number' ? cur.id : -1;
          if (curId !== bestId) return curId > bestId ? cur : best;
          // fallback to created_at comparison
          const bt = Date.parse(best.created_at || best.created || 0) || 0;
          const ct = Date.parse(cur.created_at || cur.created || 0) || 0;
          return ct > bt ? cur : best;
        }, null);
        if (argv.debug && !argv.quiet) {
          dlog(`Artifacts found: ${artifacts.length}, candidates: ${candidates.length}`);
          if (match) {
            const created = match.created_at || match.created || '';
            const size = match.size_in_bytes || match.size || '';
            dlog(`Artifact selected: id=${match.id} name="${match.name}" size=${size} created=${created}`);
            dlog(`Artifact download URL: ${match.archive_download_url}`);
          } else {
            dlog('No matching artifact found for prior GL quotes.');
          }
        }
        return { url: match?.archive_download_url || null, meta: match || null, listUrl };
      } catch (e) {
        if (argv.verbose || argv.debug) console.log(`Artifact discovery failed for ${repoName}: ${e.message}`);
        return { url: null, meta: null };
      }
    }

    // Resolve/cached the artifact URL
    if (!cache.zipUrl) {
      cache.urlPromise = cache.urlPromise || fetchArtifactZipUrl(owner, repo);
      const got = await cache.urlPromise;
      cache.zipUrl = got?.url || null;
      cache.artifactMeta = got?.meta || null;
      cache.urlPromise = null;
    }

    const zipUrl = cache.zipUrl;
    if (!zipUrl) {
      if (argv.verbose || argv.debug) console.log(`No artifact zip URL available for repo ${repo}`);
      return null;
    }

    // Try to reuse an already-loaded zip, or await an in-flight download
    let zipContent;
    if (cache.zip && cache.zipUrl === zipUrl) {
      if (argv.verbose || argv.debug) console.log(`Using cached zip for ${zipUrl}`);
      zipContent = cache.zip;
    } else if (cache.zipPromise && cache.zipUrl === zipUrl) {
      if (argv.verbose || argv.debug) console.log(`Awaiting ongoing download for ${zipUrl}`);
      try {
        zipContent = await cache.zipPromise;
      } catch (err) {
        // clear failed promise so future calls can retry
        cache.zipPromise = null;
        console.error(`Failed to load cached zip: ${err.message}`);
        return null;
      }
    } else {
      // start a new download/load and store the promise to prevent duplicate downloads
      cache.zipUrl = zipUrl;
      cache.zipPromise = (async () => {
        if (argv.verbose || argv.debug) console.log(`Downloading previous GL quotes from: ${zipUrl}`);
        const response = await fetch(zipUrl);
        if (!response.ok) {
          throw new Error(`Failed to download zip file: ${response.status} ${response.statusText}`);
        }

        try {
          const arrayBuffer = await response.arrayBuffer();

          // Check if it looks like a zip file (should start with PK)
          const firstBytes = new Uint8Array(arrayBuffer.slice(0, 2));
          if (firstBytes[0] !== 0x50 || firstBytes[1] !== 0x4B) {
            // Not a zip file, probably an HTML page with bot detection
            throw new Error('Downloaded content is not a zip file (likely bot detection page)');
          }

          const artifactZip = await new JSZip().loadAsync(arrayBuffer);
          // Use the artifact zip directly; files are in the root directory now
          cache.zip = artifactZip;
          cache.zipPromise = null;
          return artifactZip;
        } catch (err) {
          cache.zipPromise = null;
          if (argv.verbose || argv.debug) console.log(`Could not load previous GL quotes: ${err.message}`);
          return null;
        }
      })();

      try {
        zipContent = await cache.zipPromise;
      } catch (err) {
        cache.zipPromise = null;
        console.error(err.message);
        return null;
      }
    }

    // Look for the specific TSV file in the zip
    const fileInZip = zipContent.files[fileName];
    if (!fileInZip) {
      if (argv.verbose || argv.debug) console.log(`File ${fileName} not found in zip archive`);
      return null;
    }

    // Extract the content
    const content = await fileInZip.async('text');
    if (argv.verbose || argv.debug) console.log(`Successfully extracted ${fileName} from zip archive`);

    return content;
  } catch (error) {
    console.error(`Error getting previous GL quotes for ${fileName}:`, error.message);
    return null;
  }
}

/**
 * Merges previous GL quotes into the current TSV content
 * @param {string} tsvContent - The current TSV content
 * @param {string} fileName - The TSV filename to extract from the zip
 * @returns {Promise<string>} - The TSV content with GL quotes merged in
 */
async function mergePreviousGLQuotes(tsvContent, fileName, repo) {
  try {
    // Parse current TSV content
    const currentRows = tsvContent.split('\n').map(line => line.split('\t'));
    const currentHeaders = currentRows[0];

    // Check if GLQuote and GLOccurrence columns already exist
    const hasGLQuote = currentHeaders.includes('GLQuote');
    const hasGLOccurrence = currentHeaders.includes('GLOccurrence');

    if (hasGLQuote && hasGLOccurrence) {
      if (argv.verbose) {
        log(`TSV already has GLQuote and GLOccurrence columns, skipping merge`);
      }
      // Already has GL columns; report missing count for potential generation
      const glQuoteIndex = currentHeaders.indexOf('GLQuote');
      const quoteIndex = currentHeaders.indexOf('Quote') !== -1 ? currentHeaders.indexOf('Quote') : currentHeaders.indexOf('OrigQuote') !== -1 ? currentHeaders.indexOf('OrigQuote') : currentHeaders.indexOf('OrigWords');
      const occurrenceIndex = currentHeaders.indexOf('Occurrence');
      let missing = 0;
      let present = 0;
      if (glQuoteIndex >= 0) {
        for (let i = 1; i < currentRows.length; i++) {
          const row = currentRows[i];
          if (row.length > 1) {
            const quoteHasQNF = row[quoteIndex]?.includes('QUOTE_NOT_FOUND');
            const glqMissingOrQNF = (!row[glQuoteIndex]?.trim() || row[glQuoteIndex].includes('QUOTE_NOT_FOUND'));
            if (row[quoteIndex]?.trim() && row[occurrenceIndex]?.trim() && row[occurrenceIndex] != "0" && (glqMissingOrQNF || quoteHasQNF)) {
              missing++;
            } else {
              present++;
            }
          }
        }
      }
      const totalDataRows = currentRows.filter(r => r.length > 1).length;
      if (argv.debug && !argv.quiet) {
        dlog(`Book ${fileName}: already contains GLQuote/GLOccurrence. present=${present}, missing=${missing}, total=${totalDataRows}`);
      }
      return { output: tsvContent, missingCount: missing, matchedCount: 0, totalDataRows };
    }

    // Download previous GL quotes
    const previousContent = await getPreviousGLQuotes(fileName, repo);
    if (!previousContent) {
      if (argv.verbose) {
        log(`No previous GL quotes found, adding empty columns`);
      }
      // Still need to add the columns even if we can't get previous data
      const out = addEmptyGLQuoteColumns(tsvContent);
      // Everything missing since no previous
      const rows = out.split('\n').map(l => l.split('\t'));
      const glQuoteIndex = rows[0].indexOf('GLQuote');
      const occurrenceIndex = rows[0].indexOf('Occurrence');
      const quoteIndex = rows[0].indexOf('Quote') !== -1 ? rows[0].indexOf('Quote') : rows[0].indexOf('OrigQuote') !== -1 ? rows[0].indexOf('OrigQuote') : rows[0].indexOf('OrigWords');
      let missing = 0;
      if (glQuoteIndex >= 0) {
        for (let i = 1; i < rows.length; i++) if (rows[i].length > 1 && (rows[i][quoteIndex]?.trim() && rows[i][occurrenceIndex]?.trim() && rows[i][occurrenceIndex] != "0" && ((!rows[i][glQuoteIndex]?.trim() || rows[i][glQuoteIndex].includes('QUOTE_NOT_FOUND')) || rows[i][quoteIndex]?.includes('QUOTE_NOT_FOUND')))) missing++;
      }
      const totalDataRows = rows.filter(r => r.length > 1).length;
      if (argv.debug && !argv.quiet) dlog(`Book ${fileName}: artifact not available; will generate for ${missing}/${totalDataRows} rows`);
      return { output: out, missingCount: missing, matchedCount: 0, totalDataRows };
    }

    // Parse previous TSV content
    const previousRows = previousContent.split('\n').map(line => line.split('\t'));
    const previousHeaders = previousRows[0];

    // Find column indices in previous data
    const prevGLQuoteIndex = previousHeaders.indexOf('GLQuote');
    const prevGLOccurrenceIndex = previousHeaders.indexOf('GLOccurrence');
    const prevReferenceIndex = previousHeaders.indexOf('Reference');
    const prevIDIndex = previousHeaders.indexOf('ID');
    let prevQuoteIndex = previousHeaders.indexOf('Quote');
    if (prevQuoteIndex === -1) {
      prevQuoteIndex = previousHeaders.indexOf('OrigQuote');
    }
    if (prevQuoteIndex === -1) {
      prevQuoteIndex = previousHeaders.indexOf('OrigWords');
    }
    const prevOccurrenceIndex = previousHeaders.indexOf('Occurrence');

    if (prevGLQuoteIndex === -1 || prevGLOccurrenceIndex === -1) {
      if (argv.verbose) {
        log(`Previous TSV doesn't have GLQuote/GLOccurrence columns, adding empty columns`);
      }
      const out = addEmptyGLQuoteColumns(tsvContent);
      const rows = out.split('\n').map(l => l.split('\t'));
      const glQuoteIndex = rows[0].indexOf('GLQuote');
      const occurrenceIndex = rows[0].indexOf('Occurrence');
      const quoteIndex = rows[0].indexOf('Quote') !== -1 ? rows[0].indexOf('Quote') : rows[0].indexOf('OrigQuote') !== -1 ? rows[0].indexOf('OrigQuote') : rows[0].indexOf('OrigWords');
      let missing = 0;
      if (glQuoteIndex >= 0) {
        for (let i = 1; i < rows.length; i++) if (rows[i].length > 1 && (rows[i][quoteIndex]?.trim() && rows[i][occurrenceIndex]?.trim() && rows[i][occurrenceIndex] != "0" && ((!rows[i][glQuoteIndex]?.trim() || rows[i][glQuoteIndex].includes('QUOTE_NOT_FOUND')) || rows[i][quoteIndex]?.includes('QUOTE_NOT_FOUND')))) missing++;
      }
      return { output: out, missingCount: missing };
    }

    // Find column indices in current data
    const currentReferenceIndex = currentHeaders.indexOf('Reference');
    const currentIDIndex = currentHeaders.indexOf('ID');
    let currentQuoteIndex = currentHeaders.indexOf('Quote');
    if (currentQuoteIndex === -1) {
      currentQuoteIndex = currentHeaders.indexOf('OrigQuote');
    }
    if (currentQuoteIndex === -1) {
      currentQuoteIndex = currentHeaders.indexOf('OrigWords');
    }
    const currentOccurrenceIndex = currentHeaders.indexOf('Occurrence');

    if (currentOccurrenceIndex === -1) {
      console.error('No Occurrence column found in current TSV');
      return addEmptyGLQuoteColumns(tsvContent);
    }

    // Add GLQuote and GLOccurrence headers after Occurrence
    const newHeaders = [...currentHeaders];
    newHeaders.splice(currentOccurrenceIndex + 1, 0, 'GLQuote', 'GLOccurrence');

    // Process each data row
    const newRows = [newHeaders];

    let matchedCount = 0;
    for (let i = 1; i < currentRows.length; i++) {
      const currentRow = currentRows[i];
      if (currentRow.length <= 1) {
        // Skip empty rows but add the new columns
        const newRow = [...currentRow];
        while (newRow.length < newHeaders.length) {
          newRow.push('');
        }
        newRows.push(newRow);
        continue;
      }

      // Find matching row in previous data
      let matchedPrevRow = null;

      for (let j = 1; j < previousRows.length; j++) {
        const prevRow = previousRows[j];
        if (prevRow.length <= 1) continue;

        // Check for matches on Reference, ID, Quote, AND Occurrence (all must match)
        const matches = [
          currentReferenceIndex >= 0 && prevReferenceIndex >= 0 &&
          currentRow[currentReferenceIndex] === prevRow[prevReferenceIndex],

          currentIDIndex >= 0 && prevIDIndex >= 0 &&
          currentRow[currentIDIndex] === prevRow[prevIDIndex],

          currentQuoteIndex >= 0 && prevQuoteIndex >= 0 &&
          currentRow[currentQuoteIndex] === prevRow[prevQuoteIndex],

          currentOccurrenceIndex >= 0 && prevOccurrenceIndex >= 0 &&
          currentRow[currentOccurrenceIndex] === prevRow[prevOccurrenceIndex]
        ];

        if (matches.every(match => match)) {
          matchedPrevRow = prevRow;
          break;
        }
      }

      // Create new row with GLQuote and GLOccurrence values
      const newRow = [...currentRow];

      // Insert GLQuote and GLOccurrence after Occurrence column
      const glQuoteValue = matchedPrevRow ? (matchedPrevRow[prevGLQuoteIndex] || '') : '';
      const glOccurrenceValue = matchedPrevRow ? (matchedPrevRow[prevGLOccurrenceIndex] || '') : '';
      if (matchedPrevRow && (glQuoteValue !== '' || glOccurrenceValue !== '')) matchedCount++;

      newRow.splice(currentOccurrenceIndex + 1, 0, glQuoteValue, glOccurrenceValue);

      // Ensure row has correct number of columns
      while (newRow.length < newHeaders.length) {
        newRow.push('');
      }

      newRows.push(newRow);
    }

    // Convert back to TSV string
    const result = newRows.map(row => row.join('\t')).join('\n');

    // Count missing GLQuote after merge
    const mergedRows = newRows;
    const glQuoteIdx = newHeaders.indexOf('GLQuote');
    const occurrenceIdx = newHeaders.indexOf('Occurrence');
    const quoteIdx = newHeaders.indexOf('Quote') !== -1 ? newHeaders.indexOf('Quote') : newHeaders.indexOf('OrigQuote') !== -1 ? newHeaders.indexOf('OrigQuote') : newHeaders.indexOf('OrigWords');
    let missingCount = 0;
    if (glQuoteIdx >= 0) {
      for (let i = 1; i < mergedRows.length; i++) {
        const r = mergedRows[i];
        if (r.length > 1) {
          const quoteHasQNF = r[quoteIdx]?.includes('QUOTE_NOT_FOUND');
          const glqMissingOrQNF = (!r[glQuoteIdx]?.trim() || r[glQuoteIdx].includes('QUOTE_NOT_FOUND'));
          if (r[quoteIdx]?.trim() && r[occurrenceIdx]?.trim() && r[occurrenceIdx] !== "0" && (glqMissingOrQNF || quoteHasQNF)) missingCount++;
        }
      }
    }

    if (argv.verbose) {
      log(`Successfully merged GL quotes from previous version`);
    }
    const totalDataRows = mergedRows.filter(r => r.length > 1).length;
    if (argv.debug && !argv.quiet) dlog(`Book ${fileName}: cache hits=${matchedCount}, misses=${missingCount}, total=${totalDataRows}`);
    return { output: result, missingCount, matchedCount, totalDataRows };

  } catch (error) {
    console.error(`Error merging previous GL quotes:`, error.message);
    const out = addEmptyGLQuoteColumns(tsvContent);
    const rows = out.split('\n').map(l => l.split('\t'));
    const glQuoteIndex = rows[0].indexOf('GLQuote');
    const occurrenceIndex = rows[0].indexOf('Occurrence');
    const quoteIndex = rows[0].indexOf('Quote') !== -1 ? rows[0].indexOf('Quote') : rows[0].indexOf('OrigQuote') !== -1 ? rows[0].indexOf('OrigQuote') : rows[0].indexOf('OrigWords');
    let missing = 0;
    if (glQuoteIndex >= 0) {
      for (let i = 1; i < rows.length; i++) if (rows[i].length > 1 && (rows[i][quoteIndex]?.trim() && rows[i][occurrenceIndex]?.trim() && rows[i][occurrenceIndex] != "0" && ((!rows[i][glQuoteIndex]?.trim() || rows[i][glQuoteIndex].includes('QUOTE_NOT_FOUND')) || rows[i][quoteIndex]?.includes('QUOTE_NOT_FOUND')))) missing++;
    }
    const totalDataRows = rows.filter(r => r.length > 1).length;
    if (argv.debug && !argv.quiet) dlog(`Book ${fileName}: error merging previous; will generate for ${missing}/${totalDataRows}`);
    return { output: out, missingCount: missing, matchedCount: 0, totalDataRows };
  }
}

function getIndexBundle(headers) {
  const idx = {
    ref: headers.indexOf('Reference'),
    id: headers.indexOf('ID'),
    quote: headers.indexOf('Quote'),
    occ: headers.indexOf('Occurrence'),
    glq: headers.indexOf('GLQuote'),
    glo: headers.indexOf('GLOccurrence')
  };
  if (idx.quote === -1) idx.quote = headers.indexOf('OrigQuote');
  if (idx.quote === -1) idx.quote = headers.indexOf('OrigWords');
  return idx;
}

function makeRowKey(row, idx) {
  const parts = [];
  if (idx.ref >= 0) parts.push(row[idx.ref] ?? '');
  if (idx.id >= 0) parts.push(row[idx.id] ?? '');
  if (idx.quote >= 0) parts.push(row[idx.quote] ?? '');
  if (idx.occ >= 0) parts.push(row[idx.occ] ?? '');
  return parts.join('\u241F'); // unit separator-like char to reduce collisions
}

function buildPartialTSVForMissing(fullTSV) {
  let rows = fullTSV.split('\n').filter(row => row.trim()).map(l => l.split('\t'));
  let headers = rows[0];
  let idx = getIndexBundle(headers);
  // Ensure GLQuote columns exist; if not, add them so we don't end up with header-only partials
  if (idx.glq === -1 || idx.glo === -1) {
    const withCols = addEmptyGLQuoteColumns(fullTSV);
    rows = withCols.split('\n').map(l => l.split('\t'));
    headers = rows[0];
    idx = getIndexBundle(headers);
  }

  const outRows = [headers];
  const keys = new Set();
  const missingKeys = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= 1) continue;
    const quoteText = idx.quote >= 0 ? (r[idx.quote] || '') : '';
    const occText = idx.occ >= 0 ? (r[idx.occ] || '') : '';
    const glqText = idx.glq >= 0 ? (r[idx.glq] || '') : '';
    const needs = (
      (quoteText?.trim() && occText?.trim() && occText !== '0' && (!glqText?.trim() || glqText.includes('QUOTE_NOT_FOUND')))
      || (quoteText.includes('QUOTE_NOT_FOUND'))
    );
    if (needs) {
      outRows.push(r);
      const key = makeRowKey(r, idx);
      keys.add(key);
      // friendly descriptor for debug visibility
      if (missingKeys.length < 10) {
        const ref = idx.ref >= 0 ? (r[idx.ref] || '') : '';
        const id = idx.id >= 0 ? (r[idx.id] || '') : '';
        const qt = idx.quote >= 0 ? (r[idx.quote] || '') : '';
        const oc = idx.occ >= 0 ? (r[idx.occ] || '') : '';
        missingKeys.push(`${ref}${ref ? ' ' : ''}[ID:${id}] ${qt}${oc ? ` (occ ${oc})` : ''}`.trim());
      }
    }
  }
  return { partialTSV: outRows.map(r => r.join('\t')).join('\n'), keys, idx, headers, rows, missingKeys };
}

function mergePartialBack(fullTSV, partialTSV) {
  const fullRows = fullTSV.split('\n').map(l => l.split('\t'));
  const fullHeaders = fullRows[0];
  const fullIdx = getIndexBundle(fullHeaders);

  const partRows = partialTSV.split('\n').map(l => l.split('\t'));
  const partHeaders = partRows[0];
  const partIdx = getIndexBundle(partHeaders);

  // Build map key -> {glq,glo}
  const map = new Map();
  for (let i = 1; i < partRows.length; i++) {
    const r = partRows[i];
    if (r.length <= 1) continue;
    const key = makeRowKey(r, partIdx);
    map.set(key, {
      glq: partIdx.glq >= 0 ? (r[partIdx.glq] ?? '') : '',
      glo: partIdx.glo >= 0 ? (r[partIdx.glo] ?? '') : ''
    });
  }

  // Merge values
  for (let i = 1; i < fullRows.length; i++) {
    const r = fullRows[i];
    if (r.length <= 1) continue;
    const key = makeRowKey(r, fullIdx);
    const v = map.get(key);
    if (!v) continue;
    if (fullIdx.glq >= 0) r[fullIdx.glq] = v.glq;
    if (fullIdx.glo >= 0) r[fullIdx.glo] = v.glo;
  }

  return fullRows.map(r => r.join('\t')).join('\n');
}

/**
 * Adds empty GLQuote and GLOccurrence columns to TSV content
 * @param {string} tsvContent - The current TSV content
 * @returns {string} - The TSV content with empty GL quote columns added
 */
function addEmptyGLQuoteColumns(tsvContent) {
  try {
    const rows = tsvContent.split('\n').map(line => line.split('\t'));
    const headers = rows[0];
    const occurrenceIndex = headers.indexOf('Occurrence');

    if (occurrenceIndex === -1) {
      console.error('No Occurrence column found, cannot add GL quote columns');
      return tsvContent;
    }

    // Add headers
    headers.splice(occurrenceIndex + 1, 0, 'GLQuote', 'GLOccurrence');

    // Add empty values to all data rows
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length > 1) {
        rows[i].splice(occurrenceIndex + 1, 0, '', '');
      } else {
        // Handle empty rows
        while (rows[i].length < headers.length) {
          rows[i].push('');
        }
      }
    }

    return rows.map(row => row.join('\t')).join('\n');
  } catch (error) {
    console.error(`Error adding empty GL quote columns:`, error.message);
    return tsvContent;
  }
}

async function main() {
  const errors = [];
  try {
    if (workingdir && workingdir !== process.cwd()) {
      if (!fs.existsSync(argv.workingdir)) {
        throw new Error(`Working directory ${argv.workingdir} does not exist`);
      }
      process.chdir(argv.workingdir);
    }

    // Process files
    const files = fs.readdirSync('.');
    const tsvFiles = files.filter((file) => file.endsWith('.tsv') && file.split('_').length === 2);

    if (tsvFiles.length === 0) {
      throw new Error('No TSV files found in working directory');
    }

    // Determine output behavior based on flags
    const shouldCreateZip = argv.zip;
    const shouldWriteTsv = !argv.zip || argv.tsv; // Default behavior unless --zip is specified without --tsv
    const tsvSuffix = argv['tsv-suffix'] || '';

    let zip;
    if (shouldCreateZip) {
      zip = new AdmZip();
    }

    for (const file of tsvFiles) {
      log(`Processing ${file}...`);
      const bookCode = (file.split('_')?.[1]?.toLowerCase() || file.toLowerCase()).split('.')[0];
      let tsvContent = fs.readFileSync(file, 'utf8');

      // If --regenerate flag is set, all GL Quotes will be regenerated even if they exit
      if (regenerateAll) {
        if (argv.verbose) {
          log(`Regenerating all GL Quotes for ${file}`);
        }
      } else {
        if (argv.verbose) {
          log(`Attempting to merge previous GL quotes for ${file}`);
        }
        const merged = await mergePreviousGLQuotes(tsvContent, file, repo);
        tsvContent = merged.output;
        // Single-line summary (always shown unless --quiet)
        log(`Summary for ${file}: cache hits=${merged.matchedCount || 0}, to-generate=${merged.missingCount}, total=${merged.totalDataRows}`);
        if (argv.debug && !argv.quiet) {
          dlog(`Book ${file}: pre-merge summary: cache hits=${merged.matchedCount || 0}, to-generate=${merged.missingCount}, total=${merged.totalDataRows}`);
        }
        // Allow summary-only mode for tests (skip generation and exit after summary)
        if (process.env.SUMMARY_ONLY === '1') {
          // Exit right after printing the summary for deterministic tests
          process.exit(0);
        }

        // If everything is covered by previous GL quotes, skip regeneration entirely
        if (merged.missingCount === 0) {
          if (argv.verbose) log(`All rows covered by previous GL quotes for ${file}; skipping generation.`);
          const result = { output: tsvContent };
          if (shouldWriteTsv) {
            let outputFileName = file;
            if (tsvSuffix) {
              const baseName = file.replace('.tsv', '');
              outputFileName = `${baseName}_${tsvSuffix}.tsv`;
            }
            fs.writeFileSync(outputFileName, result.output, 'utf8');
            log(`Written TSV file: ${outputFileName}`);
          }
          if (shouldCreateZip) {
            zip.addFile(file, Buffer.from(result.output, 'utf8'));
          }
          // Skip to next file
          continue;
        }

        // If only some rows are missing, generate GL quotes only for those rows
        const totalRows = merged.totalDataRows ?? (tsvContent.split('\n').length - 1);
        let partialCompleted = false;
        if (merged.missingCount > 0 && merged.missingCount < totalRows) {
          if (argv.verbose) log(`Generating GL quotes for ${merged.missingCount}/${totalRows} rows in ${file}`);
          if (argv.debug && !argv.quiet) dlog(`Book ${file}: starting partial generation for ${merged.missingCount} rows`);
          const { partialTSV, missingKeys } = buildPartialTSVForMissing(tsvContent);
          if (argv.debug && !argv.quiet && missingKeys?.length) {
            dlog(`First missing rows (${Math.min(missingKeys.length, 10)} shown):`);
            for (const mk of missingKeys) dlog(`  - ${mk}`);
          }

          const partialParams = {
            bibleLinks: [targetBibleLink],
            bookCode,
            tsvContent: partialTSV,
            isSourceLanguage: true,
            trySeparatorsAndOccurrences: true,
            dcsUrl: dcsUrl,
            quiet: argv.quiet || !argv.verbose,
            usePreviousGLQuotes: !regenerateAll,
          };

          let partialResult;
          try {
            partialResult = await addGLQuoteCols(partialParams);
            // Merge back into the full TSV
            tsvContent = mergePartialBack(tsvContent, partialResult.output);
            // Recount missing; if none missing, we can skip full generation
            const rowsAfter = tsvContent.split('\n').map(l => l.split('\t'));
            const headersAfter = rowsAfter[0];
            const idxAfter = getIndexBundle(headersAfter);
            let missingAfter = 0;
            if (idxAfter.glq >= 0) {
              for (let i = 1; i < rowsAfter.length; i++) {
                const r = rowsAfter[i];
                if (r.length > 1) {
                  const quoteText = idxAfter.quote >= 0 ? (r[idxAfter.quote] || '') : '';
                  const occText = idxAfter.occ >= 0 ? (r[idxAfter.occ] || '') : '';
                  const glqText = idxAfter.glq >= 0 ? (r[idxAfter.glq] || '') : '';
                  const needs = (
                    (quoteText?.trim() && occText?.trim() && occText !== '0' && (!glqText?.trim() || glqText.includes('QUOTE_NOT_FOUND')))
                    || (quoteText.includes('QUOTE_NOT_FOUND'))
                  );
                  if (needs) missingAfter++;
                }
              }
            }
            if (argv.debug && !argv.quiet) {
              const generatedNow = merged.missingCount - missingAfter;
              dlog(`Book ${file}: partial generation done; generated=${generatedNow}, remaining missing=${missingAfter}`);
            }
            if (missingAfter === 0) {
              partialCompleted = true;
              if (argv.verbose) log(`Partial generation completed for ${file}; skipping full generation.`);
            }
          } catch (e) {
            console.error(`Partial generation failed for ${file}:`, e.message);
            // Fallback to full generation for this file
          }
        }
        if (partialCompleted) {
          const result = { output: tsvContent };
          if (shouldWriteTsv) {
            let outputFileName = file;
            if (tsvSuffix) {
              const baseName = file.replace('.tsv', '');
              outputFileName = `${baseName}_${tsvSuffix}.tsv`;
            }
            fs.writeFileSync(outputFileName, result.output, 'utf8');
            log(`Written TSV file: ${outputFileName}`);
          }
          if (shouldCreateZip) {
            zip.addFile(file, Buffer.from(result.output, 'utf8'));
          }
          continue; // move to next file; skip full generation
        }
      }

      const params = {
        bibleLinks: [targetBibleLink],
        bookCode,
        tsvContent,
        isSourceLanguage: true,
        trySeparatorsAndOccurrences: true,
        dcsUrl: dcsUrl,
        quiet: argv.quiet || !argv.verbose,
        usePreviousGLQuotes: !regenerateAll,
      };

      if (argv.verbose) {
        log(params);
      }

      let result;
      try {
        result = await addGLQuoteCols(params);
        if (argv.debug && !argv.quiet) {
          const rowsAfter = result.output.split('\n').map(l => l.split('\t'));
          const headersAfter = rowsAfter[0];
          const idxAfter = getIndexBundle(headersAfter);
          let missingAfter = 0;
          if (idxAfter.glq >= 0) {
            for (let i = 1; i < rowsAfter.length; i++) {
              const r = rowsAfter[i];
              if (r.length > 1) {
                const quoteText = idxAfter.quote >= 0 ? (r[idxAfter.quote] || '') : '';
                const occText = idxAfter.occ >= 0 ? (r[idxAfter.occ] || '') : '';
                const glqText = idxAfter.glq >= 0 ? (r[idxAfter.glq] || '') : '';
                const needs = (
                  (quoteText?.trim() && occText?.trim() && occText !== '0' && (!glqText?.trim() || glqText.includes('QUOTE_NOT_FOUND')))
                  || (quoteText.includes('QUOTE_NOT_FOUND'))
                );
                if (needs) missingAfter++;
              }
            }
          }
          const totalDataRows = rowsAfter.filter(r => r.length > 1).length;
          dlog(`Book ${file}: full generation complete; present=${totalDataRows - missingAfter}, missing=${missingAfter}, total=${totalDataRows}`);
        }
      } catch (error) {
        // Handle error from addGLQuoteCols
        if (argv.exitOnError) {
          console.error(`Error processing ${file} with addGLQuoteCols:`, error.message);
          errors.push({ file, error: error.message });
          writeErrorsToFile(errors);
          console.error('Exiting due to errors and --exit-on-error flag');
          process.exit(1);
        }

        console.error(`Error processing ${file} with addGLQuoteCols:`, error.message);
        errors.push({ file, error: error.message });

        try {
          // Fallback: Manually add GLQuote columns to TSV
          log(`Falling back to manual TSV processing for ${file}...`);

          // Read and parse the TSV
          const rows = tsvContent.split('\n').map((line) => line.split('\t'));
          const headers = rows[0];

          // Find the Occurrence column index
          const occurrenceIndex = headers.findIndex((h) => h === 'Occurrence');

          if (occurrenceIndex !== -1) {
            // Add new headers after the Occurrence column
            headers.splice(occurrenceIndex + 1, 0, 'GLQuote', 'GLOccurrence');

            // Add empty values for the new columns in all data rows
            for (let i = 1; i < rows.length; i++) {
              if (rows[i].length > 1) {
                // Skip empty rows
                rows[i].splice(occurrenceIndex + 1, 0, '', '');
              }
            }

            // Convert back to TSV
            result = {
              output: rows.map((row) => row.join('\t')).join('\n'),
            };
          } else {
            // If Occurrence column not found, just use original content
            log(`Couldn't find 'Occurrence' column in ${file}, using original content`);
            result = { output: tsvContent };
          }
        } catch (parseError) {
          console.error(`Error manually processing ${file}:`, parseError.message);
          result = { output: tsvContent }; // Use original content
        }
      }

      // Handle TSV file output
      if (shouldWriteTsv) {
        let outputFileName = file;
        if (tsvSuffix) {
          // Insert suffix before .tsv extension
          const baseName = file.replace('.tsv', '');
          outputFileName = `${baseName}_${tsvSuffix}.tsv`;
        }

        fs.writeFileSync(outputFileName, result.output, 'utf8');
        log(`Written TSV file: ${outputFileName}`);
      }

      // Handle zip file output
      if (shouldCreateZip) {
        zip.addFile(file, Buffer.from(result.output, 'utf8'));
      }
    }

    // Write zip file if requested
    if (shouldCreateZip) {
      zip.writeZip(zipFilePath);
      log(`Created ${zipFilePath}`);
    }

    if (errors.length > 0) {
      writeErrorsToFile(errors);
    }
  } catch (error) {
    console.error('Error:', error.message);
    writeErrorsToFile([{ file: '', error: error.message }]);
    process.exit(1);
  }
}

main();
