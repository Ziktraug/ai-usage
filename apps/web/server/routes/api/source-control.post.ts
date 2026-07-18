import { defineHandler } from 'nitro';
import { handleSourceControlCommandRequest } from '../../../src/server/source-control-api.server';

export default defineHandler((event) => handleSourceControlCommandRequest(event.req));
