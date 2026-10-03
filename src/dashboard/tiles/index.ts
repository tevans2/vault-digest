import type { TileType } from "./common";
import { announcements, notices } from "./announcements";
import { radar } from "./radar";
import { today, work, courses } from "./tasks";
import { weakSpots, recentInbox } from "./notes";
import { paStatus } from "./assistant";
import { plan, timeline } from "./brief";
import { capture } from "./capture";
import { closeForm, triage, changes, weekReview } from "./review";
import { runBar, load, waiting } from "./glance";
import { channel, messages } from "./messages";
import { actions } from "./actions";
import { calendar } from "./calendar";

export const TILES: Record<string, TileType> = Object.fromEntries(
  [announcements, radar, today, work, courses, weakSpots, recentInbox, paStatus, plan, timeline, capture, closeForm, triage, changes, weekReview, notices, runBar, load, waiting, channel, messages, actions, calendar].map((t) => [t.id, t])
);
