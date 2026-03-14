import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.interval(
  'cleanup expired watch sessions',
  { hours: 1 },
  internal.sessions.cleanupExpiredSessions
);

export default crons;
