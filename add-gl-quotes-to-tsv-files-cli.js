#!/usr/bin/env node

import { addGLQuoteCols } from 'tsv-quote-converters';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { execSync } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { BibleBookData } from './books.js';
import * as usfm from 'usfm-js';
import * as axios from 'axios';
import fetch from 'node-fetch';
import { createHash } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';

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
    e: {
      alias: 'exit-on-error',
      describe: 'Exit on error. If there are any errors with the TSV file or loading a Bible book, the script should stop instantly and not make a zip file. (default: false)',
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
  if (!argv.quiet || argv.verbose) console.log(...args);
};

// Get info from different sources
const gitInfo = getGitInfo();
// Load environment variables from .env file
dotenv.config();

const ghOwner = process.env.GITHUB_REPOSITORY?.split('/')[0];
const ghRepo = process.env.GITHUB_REPOSITORY?.split('/')[1];

// Prioritize sources
const workingdir = argv.workingdir || process.cwd();
const owner = argv.owner || ghOwner || gitInfo.owner || 'unfoldingWord';
const repo = argv.repo || ghRepo || gitInfo.repo || path.basename(process.cwd()) || 'unknown';
const ref = argv.ref || process.env.GITHUB_REF_NAME || gitInfo.ref || 'master';
const dcsUrl = argv.dcs || process.env.GITHUB_SERVER_URL || gitInfo.dcsUrl || 'https://git.door43.org';
const targetBibleLink =
  argv.bible ||
  process.env.BIBLE_LINK ||
  getTargetBibleLink() ||
  (owner === 'unfoldingWord' ? `${owner}/${repo.split('_')[0]}_ult/master` : `${owner}/${repo.split('_')[0]}_glt/master`);

log('owner:', owner, 'repo:', repo, 'ref:', ref, 'dcsUrl:', dcsUrl, 'targetBibleLink:', targetBibleLink);
if (!owner || !repo || !ref || !dcsUrl) {
  console.error('Error: Missing required parameters. Use --help for usage information.');
  process.exit(1);
}

const zipFilePath = argv.output || `${repo}_${ref}_with_gl_quotes.zip`;

const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const awsRegion = process.env.AWS_REGION || 'us-west-2'; // Default region
const tableName = process.env.DYNAMODB_TABLE || 'GLQuotes';
    
// Initialize DynamoDB client with credentials from environment variables
const docClient = new DynamoDBClient({ 
  region: awsRegion,
  credentials: {
    accessKeyId: awsAccessKeyId,
    secretAccessKey: awsSecretAccessKey,
  }
});

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

function writeErrorsToFile(errors) {
  if (!errors || errors.length === 0) {
    return;
  }

  try {
    const errorData = {
      timestamp: new Date().toISOString(),
      errors: errors
    };

    const errorFilePath = path.join(workingdir, 'errors.json');
    fs.writeFileSync(errorFilePath, JSON.stringify(errorData, null, 2), 'utf8');

    if (!argv.quiet) {
      console.log(`Errors written to ${errorFilePath}`);
    }
  } catch (error) {
    console.error('Failed to write errors to file:', error.message);
  }
}

/**
 * Gets the SHA of each chapter for a specific Bible book from DCS for a given Bible link.
 * @param {string} usfmConten - the USFM content as a string
 * @returns {object} - The keyed by chapter SHAs
 */
function getChapterShas(usfmContent) {
  try {
    const chapters = usfm.toJSON(usfmContent).chapters;
    const shas = {};
    Object.keys(chapters).forEach(chapterNumber => {
      if (!isNaN(parseInt(chapterNumber))) {
        shas[chapterNumber] = createHash('sha256').update(JSON.stringify(chapters[chapterNumber])).digest('hex');
      }
    });

    return shas;
  } catch (error) {
    console.error(`Error converting USFM content to json:`, error.message);
    return;
  }
}

/**
 * Fetches the USFM content for a specific Bible book from DCS
 * @param {string} bibleLink - The Bible link in format "owner/repo/ref"
 * @param {string} bookId - The book ID (e.g., 'gen', 'exo', 'mat')
 * @returns {Promise<string>} - The USFM content as a string, or empty string if not found
 */
async function fetchUsfmContent(bibleLink, bookId) {
  try {
    // Validate inputs
    if (!bibleLink || !bookId || !dcsUrl) {
      console.error('Missing required parameters for fetchUsfmContent');
      return '';
    }

    if (!BibleBookData[bookId]) {
      console.error(`Unknown book ID: ${bookId}`);
      return '';
    }

    // Parse the Bible link
    const parts = bibleLink.split('/');
    const owner = parts[0];
    const repo = parts[1];
    const ref = parts[2] || 'master';

    // Construct the API URL
    const usfmFileName = `${BibleBookData[bookId].usfm}.usfm`;
    const apiUrl = `${dcsUrl}/api/v1/repos/${owner}/${repo}/contents/${usfmFileName}?ref=${ref}`;
    
    if (argv.verbose) {
      log(`Fetching USFM content from: ${apiUrl}`);
    }

    // Fetch the content
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      if (argv.verbose) {
        log(`Failed to fetch USFM content for ${bookId}: ${response.status} ${response.statusText}`);
      }
      return '';
    }

    const data = await response.json();
    
    if (!data || !data.content) {
      return '';
    }

    // Decode base64 content
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return content;
  } catch (error) {
    console.error(`Error fetching USFM content for ${bookId}:`, error.message);
    return '';
  }
}

/**
 * 
 * @param {object} item 
 */
async function putGLQuoteRowToDynamoDB(item) {
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      if (argv.verbose) {
        log('AWS credentials not found in environment variables. Skipping DynamoDB put.');
      }
      return null;
    }

    // Insert the new quote
    const putParams = {
      TableName: tableName,
      Item: item,
    };

    console.log(putParams);
          
    console.log(`Inserted quote for ${item.Book} ${item.Reference} into DynamoDB`);
    await docClient.send(new PutCommand(putParams));
}

/**
 * Query DynamoDB table for Bible book content using AWS credentials from environment variables
 * @param {string} bibleLink - The Bible link in format "owner/repo/ref" (used as partition key)
 * @param {string} bookId - The book ID (e.g., 'gen', 'exo', 'mat') (used as sort key)
 * @returns {Promise<Object|null>} - The DynamoDB item containing the book data, or null if not found
 */
async function queryDynamoDBForBook(bibleLink, bookId) {
  try {
    if (!awsAccessKeyId || !awsSecretAccessKey) {
      if (argv.verbose) {
        log('AWS credentials not found in environment variables. Skipping DynamoDB query.');
      }
      return null;
    }

    // Construct the command to get the item
    const command = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'OwnerRepoRef = :orr AND Book = :book',
      ExpressionAttributeValues: { ':orr': bibleLink, ':book': bookId }
    });

    if (argv.verbose) {
      log(`Querying DynamoDB for PK: ${bibleLink}, SK: ${bookId}`);
    }

    // Execute the command
    const response = await docClient.send(command);

    // Return the item if found, otherwise null
    return response.Items || null;
  } catch (error) {
    console.error(`Error querying DynamoDB for ${bibleLink}/${bookId}:`, error.message);
    console.log(error);
    return null;
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
    const tsvFiles = files.filter((file) => file.endsWith('.tsv'));

    if (tsvFiles.length === 0) {
      throw new Error('No TSV files found in working directory');
    }

    const zip = new AdmZip();

    for (const file of tsvFiles) {
      log(`Processing ${file}...`);
      const bookCode = (file.split('_')?.[1]?.toLowerCase() || file.toLowerCase()).split('.')[0];
      const tsvContent = fs.readFileSync(file, 'utf8');

      const sourceUsfmContent = await fetchUsfmContent(BibleBookData[bookCode].testament == "old" ? "unfoldingWord/hbo_uhb" : "unfoldingWord/el-x-koine_ugnt", bookCode, dcsUrl);
      const sourceChapterShas = getChapterShas(sourceUsfmContent);

      const targetUsfmContent = await fetchUsfmContent(targetBibleLink, bookCode);
      const targetChapterShas = await getChapterShas(targetUsfmContent);

      const cachedGLQuotes = await queryDynamoDBForBook(targetBibleLink, bookCode);
      console.log(cachedGLQuotes)

      if (argv.verbose) {
        log("Source chapter SHAs:", sourceChapterShas);
        log("Target chapter SHAs:", targetChapterShas);
      }

      const params = {
        bibleLinks: [targetBibleLink],
        bookCode,
        tsvContent,
        isSourceLanguage: true,
        trySeparatorsAndOccurrences: true,
        dcsUrl: dcsUrl,
        quiet: argv.quiet || !argv.verbose,
      };

      if (argv.verbose) {
        log(params);
      }

      let result;
      try {
        result = await addGLQuoteCols(params);
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
            headers.splice(occurrenceIndex + 1, 0, 'GLQuote', 'GLQuote Occurrence');

            // Add empty values for the new columns in all data rows
            for (let i = 1; i < rows.length; i++) {
              if (rows[i].length > 1) {
                // Skip empty rows
                rows[i].splice(occurrenceIndex + 1, 0, '', '0');
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

      const tsvRecords = parse(result.output, {
        columns: true,
        delimiter: '\t',
        quote: '',
        skip_empty_lines: true,
      });

      for(let record of tsvRecords) {
        if (record['GLQuote'] && record['GLQuote'] !== '') {
          const chapter = record['Reference'].split(':')[0].split('-')[0];
          if (targetChapterShas[chapter] && sourceChapterShas[chapter]) {
            GLQuotesRow = {
              OwnerRepoRef: owner + '/' + repo + '/' + ref,
              Book: bookCode,
              Owner: owner,
              Repo: repo,
              Ref: ref,
              Language: repo.split('_')[0], 
              Reference: record['Reference'],
              Quote: record['Quote'],
              Occurrence: record['Occurrence'],
              GLQuote: record['GLQuote'],
              GLOccurrence: record['GLOccurrence'],
              Chapter: chapter,
              SHA: sourceChapterShas[chapter],
              GLSHA: targetChapterShas[chapter],
              CreatedAt: new Date().toISOString(),
            }

            await putGLQuoteRowToDynamoDB(GLQuotesRow);
          }              
        }
      }

      zip.addFile(file, Buffer.from(result.output, 'utf8'));
      process.exit(0);
    }

    // Write zip file
    zip.writeZip(zipFilePath);
    log(`Created ${zipFilePath}`);

    if (errors.length > 0) {
      writeErrorsToFile(errors);
    }
  } catch (error) {
    console.error('Error:', error.message);
    console.log(error);
    writeErrorsToFile([{ file: '', error: error.message }]);
    process.exit(1);
  }
}

main();
