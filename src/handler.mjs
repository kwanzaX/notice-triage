// Lambda handler behind an API Gateway HTTP API.
//   POST /notices        ingest a notice (idempotent on id) and assess it
//   GET  /notices/{id}   read the stored assessment
//
// Storage: the raw notice goes to S3, the assessment to DynamoDB. The DynamoDB write is a
// conditional put on the id, so a retried or duplicated POST never creates a second record.

import { DynamoDBClient, PutItemCommand, GetItemCommand, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { assess, validateNotice } from './analyze.mjs';
import { refine, openAICompatible } from './llm.mjs';

const log = (o) => console.log(JSON.stringify(o)); // one JSON line per event: queryable in CloudWatch Logs Insights

export function makeHandler({ ddb = new DynamoDBClient({}), s3 = new S3Client({}), table = process.env.TABLE, bucket = process.env.BUCKET, model = defaultModel(), now = () => new Date() } = {}) {
  return async (event) => {
    const started = Date.now();
    const method = event.requestContext?.http?.method;
    const path = event.rawPath || '';
    try {
      if (method === 'POST' && path === '/notices') return await ingest(event);
      const m = path.match(/^\/notices\/([\w.:-]{1,128})$/);
      if (method === 'GET' && m) return await read(m[1]);
      return json(404, { error: 'not found' });
    } catch (err) {
      log({ event: 'error', method, path, error: err.message, ms: Date.now() - started });
      return json(500, { error: 'internal error' });
    } finally {
      log({ event: 'request', method, path, ms: Date.now() - started });
    }
  };

  async function ingest(event) {
    let notice;
    try {
      notice = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body || '');
    } catch {
      return json(400, { error: 'body must be JSON' });
    }
    const errors = validateNotice(notice);
    if (errors.length) return json(400, { errors });

    let result = assess(notice, { now: now() });
    if (model) result = await refine(notice, result, { complete: model, log });

    // Content-addressed: re-sending the same notice rewrites the same object; a different body under
    // the same id lands in its own object instead of overwriting the one the assessment points to.
    const raw = JSON.stringify(notice);
    const s3Key = `notices/${notice.id}/${createHash('sha256').update(raw).digest('hex').slice(0, 16)}.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key, Body: raw, ContentType: 'application/json' }));

    const item = {
      pk: { S: notice.id },
      venue: { S: notice.venue },
      title: { S: notice.title },
      impact: { S: result.impact },
      urgent: { BOOL: result.urgent },
      assessment: { S: JSON.stringify(result) },
      s3Key: { S: s3Key },
      receivedAt: { S: now().toISOString() },
    };
    try {
      await ddb.send(new PutItemCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || err.name === 'ConditionalCheckFailedException') {
        log({ event: 'duplicate', id: notice.id });
        const existing = await getItem(notice.id);
        return json(200, { duplicate: true, ...existing });
      }
      throw err;
    }
    log({ event: 'assessed', id: notice.id, impact: result.impact, urgent: result.urgent, source: result.source });
    return json(201, { duplicate: false, id: notice.id, ...result });
  }

  async function read(id) {
    const item = await getItem(id);
    return item ? json(200, item) : json(404, { error: 'not found' });
  }

  async function getItem(id) {
    const out = await ddb.send(new GetItemCommand({ TableName: table, Key: { pk: { S: id } }, ConsistentRead: true }));
    if (!out.Item) return null;
    return { id, venue: out.Item.venue.S, title: out.Item.title.S, receivedAt: out.Item.receivedAt.S, ...JSON.parse(out.Item.assessment.S) };
  }
}

function defaultModel() {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  return LLM_BASE_URL && LLM_API_KEY && LLM_MODEL ? openAICompatible({ baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL }) : null;
}

function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler = makeHandler();
