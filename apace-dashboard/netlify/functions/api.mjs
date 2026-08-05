import serverless from 'serverless-http';
import { createApp } from '../../server/app.js';

// Built once per cold start and reused across invocations.
export const handler = serverless(createApp());
