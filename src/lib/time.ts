export const addMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60_000);

export const addHours = (date: Date, hours: number): Date =>
  new Date(date.getTime() + hours * 3_600_000);

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);
