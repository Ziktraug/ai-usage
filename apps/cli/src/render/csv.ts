import { serializedRowsToCSV } from '@ai-usage/report-core/csv';
import { serializeUsageRow } from '@ai-usage/report-core/report-data';
import type { Row } from '@ai-usage/report-core/types';

export const renderCSV = (rows: Row[]) => serializedRowsToCSV(rows.map(serializeUsageRow));
