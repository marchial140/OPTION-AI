const timezone = "America/New_York";
const calendarSource = "https://www.nyse.com/trade/hours-calendars";
const localClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const openMinute = 9 * 60 + 30;
const regularClose = 16 * 60;
const shortClose = 13 * 60;
const extendedOpen = 4 * 60;
const extendedClose = 20 * 60;
const shortExtendedClose = 17 * 60;
const dayMs = 86_400_000;

const labels = {
  "pre-market": "Préouverture",
  regular: "Marché ouvert",
  "after-hours": "Après séance",
  closed: "Marché fermé",
  holiday: "Jour férié",
} as const;

export type MarketStatus = keyof typeof labels;

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function newYorkParts(date: Date) {
  const parts = new Map(localClock.formatToParts(date).map(({ type, value }) => [type, value]));
  const time = `${parts.get("hour")}:${parts.get("minute")}`;
  return {
    date: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`,
    time,
    minute: Number(parts.get("hour")) * 60 + Number(parts.get("minute")),
  };
}

function nthWeekday(year: number, month: number, weekday: number, nth: number) {
  const start = new Date(Date.UTC(year, month, 1));
  return dateKey(new Date(Date.UTC(year, month, 1 + (weekday - start.getUTCDay() + 7) % 7 + 7 * (nth - 1))));
}

function lastWeekday(year: number, month: number, weekday: number) {
  const end = new Date(Date.UTC(year, month + 1, 0));
  return dateKey(new Date(end.getTime() - ((end.getUTCDay() - weekday + 7) % 7) * dayMs));
}

function observed(year: number, month: number, day: number, friday = true) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCDay() === 6 && friday) date.setUTCDate(day - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(day + 1);
  return dateKey(date);
}

// Gregorian computation of Easter Sunday, then offset to Good Friday.
function goodFriday(year: number) {
  const a = year % 19;
  const century = Math.floor(year / 100);
  const yearOfCentury = year % 100;
  const lunar = (19 * a + century - Math.floor(century / 4) -
    Math.floor((century - Math.floor((century + 8) / 25) + 1) / 3) + 15) % 30;
  const solar = (32 + 2 * (century % 4) + 2 * Math.floor(yearOfCentury / 4) - lunar - yearOfCentury % 4) % 7;
  const correction = Math.floor((a + 11 * lunar + 22 * solar) / 451);
  const offset = lunar + solar - 7 * correction + 114;
  return dateKey(new Date(Date.UTC(year, Math.floor(offset / 31) - 1, offset % 31 - 1)));
}

function getTradingDay(date: string) {
  const calendarDate = new Date(`${date}T00:00:00.000Z`);
  const year = calendarDate.getUTCFullYear();
  const weekday = calendarDate.getUTCDay();
  if (weekday === 0 || weekday === 6) return { holiday: false, closed: true, earlyClose: false };
  const thanksgiving = nthWeekday(year, 10, 4, 4);
  const holidays = [
    observed(year, 0, 1, false),
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    goodFriday(year),
    lastWeekday(year, 4, 1),
    observed(year, 5, 19),
    observed(year, 6, 4),
    nthWeekday(year, 8, 1, 1),
    thanksgiving,
    observed(year, 11, 25),
    "2025-01-09", // National day of mourning for President Carter.
  ];
  const holiday = holidays.includes(date);
  const earlyClose = !holiday && [
    dateKey(new Date(Date.parse(thanksgiving) + dayMs)),
    `${year}-07-03`,
    `${year}-12-24`,
  ].includes(date);
  return { holiday, closed: holiday, earlyClose };
}

function openingTimestamp(date: string) {
  const standardOpening = new Date(`${date}T14:30:00.000Z`);
  const offsetMinutes = newYorkParts(standardOpening).minute - openMinute;
  return new Date(standardOpening.getTime() - offsetMinutes * 60_000).toISOString();
}

export function marketSession(at = new Date()) {
  const local = newYorkParts(at);
  const session = getTradingDay(local.date);
  const close = session.earlyClose ? shortClose : regularClose;
  const lastTrade = session.earlyClose ? shortExtendedClose : extendedClose;
  let status: MarketStatus = "closed";
  if (session.holiday) status = "holiday";
  else if (!session.closed && local.minute >= extendedOpen && local.minute < openMinute) status = "pre-market";
  else if (!session.closed && local.minute >= openMinute && local.minute < close) status = "regular";
  else if (!session.closed && local.minute >= close && local.minute < lastTrade) status = "after-hours";

  let nextOpen: string | undefined;
  if (status !== "regular") {
    let nextDate = local.date;
    if (session.closed || local.minute >= openMinute) {
      do {
        nextDate = dateKey(new Date(Date.parse(nextDate) + dayMs));
      } while (getTradingDay(nextDate).closed);
    }
    nextOpen = openingTimestamp(nextDate);
  }

  return {
    status,
    label: labels[status],
    time: local.time,
    nyTime: local.time,
    date: local.date,
    timezone,
    optionsOpen: status === "regular",
    optionsRegularSession: status === "regular",
    earlyClose: session.earlyClose,
    nextOpen,
    source: calendarSource,
  };
}
