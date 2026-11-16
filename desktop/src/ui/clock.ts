/**
 * Times of day as this computer shows them ("Clock times", #116): on its
 * 12- or 24-hour clock, and with the date, in US order, when it isn't
 * today. The desktop reads the computer's setting (`time_format`), since a
 * WebView's `Intl` goes by its language alone; without one, the language
 * decides.
 */
import { inApp } from "../ipc";
import { commands } from "../wire/api.gen";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** What the language and region show, where the computer's settings say nothing. */
function localeTwelveHour(): boolean {
  const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12";
}

let twelveHour = localeTwelveHour();

/** Shows times on a 12-hour clock (`true`), a 24-hour one, or as the locale does (`null`). */
export function setTwelveHour(setting: boolean | null): void {
  twelveHour = setting ?? localeTwelveHour();
}

/** Asks the desktop how this computer shows times; outside the app, the locale decides. */
export async function loadTimeFormat(): Promise<void> {
  if (!inApp()) return;
  const format = await commands.time_format().catch(() => ({ twelve_hour: null }));
  setTwelveHour(format.twelve_hour);
}

/** "9:12 AM", or "09:12" on a 24-hour clock. */
function time(d: Date): string {
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const hours = d.getHours();
  if (!twelveHour) return `${String(hours).padStart(2, "0")}:${minutes}`;
  return `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/** "Sun, Oct 4". */
function day(d: Date): string {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Aug 8", and "Dec 31, 2025" in another year than `now`'s: a day as a status line gives it. */
export function monthDay(at: number, now: number): string {
  const d = new Date(at);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** "Sat, Aug 8", with ", 2025" in another year than `now`'s: a day Runs counts its ended runs since. */
export function weekdayDate(at: number, now: number): string {
  const d = new Date(at);
  const date = day(d);
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LONG_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Tuesday, August 11", with ", 2025" in another year than `now`'s: Runs' heading for a day's ended runs. */
export function longDay(at: number, now: number): string {
  const d = new Date(at);
  const date = `${LONG_DAYS[d.getDay()]}, ${LONG_MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** `at` on the day of `now` is its time alone; another day's has its date first. */
export function clock(at: number, now: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return time(d);
  return `${day(d)}, ${time(d)}`;
}

/** `clock`, its date and time each kept on one line in a sentence: "Sat, Aug\u00a015, 11:10\u00a0PM". */
export const clockInSentence = (at: number, now: number): string =>
  clock(at, now).replace(/(?<!,) /g, "\u00a0");

/** Home's date line: "Wed, Aug 12 · 10:44 AM". */
export function dateLine(now: Date): string {
  return `${day(now)} · ${time(now)}`;
}
