#!/usr/bin/env node

import { addGLQuoteCols } from 'tsv-quote-converters';
import AdmZip from 'adm-zip';
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
    const dcsUrl = remoteUrl.match(/(https*:\/\/[^\/]+)/)
      ? remoteUrl.match(/(https*:\/\/[^\/]+)/)[1]
      : remoteUrl.match(/@(.*?):/)
      ? `https://${remoteUrl.match(/@(.*?):/)[1]}`
      : null;
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
    o: {
      alias: 'output',
      describe: 'Output zip file\'s path. (default:  {workingdir}/{repo}_{ref}_with_gl_quotes.zip)',
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
    }
  })
  .epilogue(
    'Priority for parameters:\n' +
      '1. Command line arguments\n' +
      '2. GitHub Actions environment variables\n' +
      '3. Git repository information\n\n' +
      'If no path for the output zip file is specified, it will be generated as: <repo>_<ref>_with_gl_quotes.zip in the woring directory'
  ).argv;

const log = (...args) => {
  if (!argv.quiet || verbose) console.log(...args);
};

// Get info from different sources
const gitInfo = getGitInfo();
const ghOwner = process.env.GITHUB_REPOSITORY?.split('/')[0];
const ghRepo = process.env.GITHUB_REPOSITORY?.split('/')[1];

// Prioritize sources
const workingdir = argv.workingdir || process.cwd();
const owner = argv.owner || ghOwner || gitInfo.owner || 'unfoldingWord';
const repo = argv.repo || ghRepo || gitInfo.repo || path.basename(process.cwd()) || 'unknown';
const ref = argv.ref || process.env.GITHUB_REF_NAME || gitInfo.ref || 'master';
const dcsUrl = argv.dcs || process.env.GITHUB_SERVER_URL || gitInfo.dcsUrl || 'https://git.door43.org';
const targetBibleLink = argv.bible || process.env.BIBLE_LINK || getTargetBibleLink() || (owner === 'unfoldingWord' ? `${owner}/${repo.split('_')[0]}_ult/master` : `${owner}/${repo.split('_')[0]}_glt/master`);

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
log(`TargetBibleLink: ${targetBibleLink}`)
log(`DCS URL: ${dcsUrl}`);
log(`Output file path: ${zipFilePath}`);

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

async function main() {
  try {
    if (workingdir && workingdir !== process.cwd()) {
      if (!fs.existsSync(argv.workingdir)) {
        throw new Error(`Working directory ${argv.workingdir} does not exist`);
      }
      process.chdir(argv.workingdir);
    }

    // Process files
    const files = fs.readdirSync('.');
    const tsvFiles = files.filter((file) => file.endsWith('.tsv'));

    if (tsvFiles.length === 0) {
      throw new Error('No TSV files found in working directory');
    }

    const zip = new AdmZip();

    for (const file of tsvFiles) {
      log(`Processing ${file}...`);
      const bookCode = (file.split('_')?.[1]?.toLowerCase() || file.toLowerCase()).split('.')[0];
      const tsvContent = fs.readFileSync(file, 'utf8');

      const params = {
        bibleLinks: [targetBibleLink],
        bookCode,
        tsvContent,
        isSourceLanguage: true,
        trySeparatorsAndOccurrences: true,
        dcsUrl: dcsUrl,
        quiet: quiet && !verbose,
      };

      if (verbose) {
        log(params);
      }

      const result = await addGLQuoteCols(params);

      zip.addFile(file, Buffer.from(result.output, 'utf8'));
    }

    // Write zip file
    zip.writeZip(zipFilePath);
    log(`Created ${zipFilePath}`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
