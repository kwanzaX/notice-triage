# notice-triage

Assess exchange and venue notices on AWS. A notice comes in (a session-hours change, a fee update, a FIX gateway migration, a new tick-size table) and comes out with an impact level, the internal systems it touches and what to do about it.

```
POST /notices
{"id":"XAMS-2026-201","venue":"XAMS","title":"FIX gateway migration and fee update",
 "body":"The FIX session gateway moves to a new IP range on 1 December. Clearing fees will increase from the same date.",
 "effectiveDate":"2026-12-01"}

201 {"impact":"high","categories":["fee_change","connectivity"],
     "affectedSystems":["billing","connectivity","order-routing","reconciliation"],
     "actions":["Update fee schedules and re-run reconciliation…","Test the new endpoint or protocol version in UAT…"],
     "urgent":false,"daysUntilEffective":56,"source":"rules"}
```

## Architecture

```
API Gateway (HTTP API) ──► Lambda (Node.js 22) ──► S3        raw notice, content-addressed
                                │                 └► DynamoDB  assessment, conditional put on id
                                └──► optional LLM (OpenAI-compatible) with a hard time budget
CloudWatch: one JSON log line per event + an alarm on Lambda errors (optional SNS email)
```

Everything is one CloudFormation template (`template.yaml`): table, bucket, least-privilege role (`PutItem`/`GetItem` on the table, `PutObject` under `notices/` only), function, log group with 14-day retention, HTTP API, alarm.

## Decisions

- **Idempotent ingest.** The DynamoDB write is a conditional put on the notice id, so a retried or duplicated POST returns the existing assessment (`200`, `duplicate: true`) instead of creating a second record.
- **Raw notices are content-addressed in S3** (`notices/{id}/{sha256}.json`). A different body sent under an existing id lands in its own object and never overwrites the one the assessment was made from.
- **Rules first, model second.** Deterministic rules give every notice an explainable floor. An optional LLM can raise the impact and add a summary, never lower it. If the model times out (4 s budget, `AbortSignal`), fails or replies off-schema, the rules result stands and the fallback reason is logged.
- **Notices due within 3 days are urgent**, and a medium change that close is treated as high.
- **Observability.** Each request logs one JSON line (`request`, `assessed`, `duplicate`, `llm.ok`, `llm.fallback`, `error`) with latency, so CloudWatch Logs Insights can filter by field, e.g. `{ $.event = "llm.fallback" }`.

## Deploy

```
aws s3 cp lambda.zip s3://<code-bucket>/notice-triage/<hash>.zip      # zip of src/ + package.json
aws cloudformation deploy --stack-name notice-triage --template-file template.yaml \
  --capabilities CAPABILITY_IAM --parameter-overrides CodeBucket=<code-bucket> CodeKey=notice-triage/<hash>.zip
```

The AWS SDK v3 ships with the Node.js 22 Lambda runtime, so the zip has no dependencies. To enable the model, set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` on the function.

## Tests

```
npm install && npm test                         # 8 unit tests with in-memory DynamoDB/S3 fakes
API_URL=https://<api-id>.execute-api.<region>.amazonaws.com npm run e2e
```

The end-to-end script was run against a deployed stack in `eu-central-1`: create (201), duplicate (200, not re-written), read (200), invalid input (400), unknown id (404).
