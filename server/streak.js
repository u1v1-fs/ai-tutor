// Pure streak logic — separated so it can be unit-tested without the store.
export function updateStreak(streak, today, yesterday) {
  const s = { count: 0, best: 0, last: null, days: [], ...(streak || {}) };
  if (s.last === today) return s;
  s.count = s.last === yesterday ? (s.count || 0) + 1 : 1;
  s.best = Math.max(s.best || 0, s.count);
  s.last = today;
  s.days = [...(s.days || []), today].slice(-60);
  return s;
}

export function calendarYesterday(date = new Date()) {
  const y = new Date(date);
  y.setDate(y.getDate() - 1);
  return y.toLocaleDateString("en-CA");
}
