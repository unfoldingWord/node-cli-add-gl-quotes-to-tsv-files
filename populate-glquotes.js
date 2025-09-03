import 'dotenv/config';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

// Initialize DynamoDB client with credentials from environment variables
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const docClient = DynamoDBDocumentClient.from(client);

// Table name
const TABLE_NAME = "GLQuotes";

// Function to compute a quote (placeholder)
async function computeQuote(book, language = "en") {
  // Replace with your actual quote generation logic (e.g., translation API)
  return `Quote_${book}_${language}`;
}

// Function to get or insert a quote for owner/repo/ref/book
async function getOrInsertQuote(owner, repo, ref, book, language = "en") {
  try {
    // Construct the partition key
    const ownerRepoRef = `${owner}/${repo}/${ref}`;

    // Check if the quote exists
    const queryParams = {
      TableName: TABLE_NAME,
      KeyConditionExpression: "OwnerRepoRef = :orr AND Book = :book",
      ExpressionAttributeValues: {
        ":orr": ownerRepoRef,
        ":book": book,
      },
    };
    
    console.log(queryParams);

    const queryCommand = new QueryCommand(queryParams);
    const queryResult = await docClient.send(queryCommand);

    console.log(queryResult.Items);

    if (queryResult.Items && queryResult.Items.length > 0) {
      return queryResult.Items[0].quote;
    }

    // If not found, compute the quote
    const newQuote = await computeQuote(book, language);

    // Insert the new quote
    const putParams = {
      TableName: TABLE_NAME,
      Item: {
        OwnerRepoRef: ownerRepoRef,
        Book: book,
        quote: newQuote,
        owner: owner,
        repo: repo,
        ref: ref,
        language: language,
        createdAt: new Date().toISOString(),
      },
    };

    await docClient.send(new PutCommand(putParams));
    console.log(`Inserted quote for ${ownerRepoRef}/${book}: ${newQuote}`);

    return newQuote;
  } catch (error) {
    console.error("Error in getOrInsertQuote:", error);
    throw error;
  }
}

// Function to populate the table with sample data
async function populateTable() {
  const sampleData = [
    { owner: "unfoldingWord", repo: "en_ult", ref: "master", book: "1ch", language: "en" },
    { owner: "unfoldingWord", repo: "en_ult", ref: "master", book: "1ti", language: "en" },
    { owner: "unfoldingWord", repo: "en_ult", ref: "master", book: "1th", language: "en" },
    { owner: "unfoldingWord", repo: "en_ult", ref: "master", book: "1ki", language: "en" },
  ];

  for (const { owner, repo, ref, book, language } of sampleData) {
    try {
      const quote = await getOrInsertQuote(owner, repo, ref, book, language);
      console.log(`Processed ${owner}/${repo}/${ref}/${book}: ${quote}`);
    } catch (error) {
      console.error(`Failed to process ${owner}/${repo}/${ref}/${book}:`, error);
    }
  }
}

// Run the population script
(async () => {
  try {
    await populateTable();
    console.log("Table population completed");
  } catch (error) {
    console.error("Failed to populate table:", error);
  }
})();
