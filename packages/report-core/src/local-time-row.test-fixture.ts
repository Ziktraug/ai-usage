interface LocalTimeRowFields {
  activeDate: string;
  date: string;
  endDate: string;
}

export const localTimeRowFields = (day: number, hour: number, minute: number): LocalTimeRowFields => {
  const timestamp = new Date(2026, 6, day, hour, minute).toISOString();
  return { activeDate: timestamp, date: timestamp, endDate: timestamp };
};
