const DAY = 86400;

export function buildIntelInsights(member, context = {}, now = Math.floor(Date.now() / 1000)) {
  const insights = [];

  addInactive(insights, member, now);
  addWarParticipation(insights, member);
  addActivity(insights, member);
  addXanax(insights, member);
  addBattleStats(insights, member, now);
  addStrongWarOutput(insights, member, context);

  return insights;
}

function addInactive(insights, member, now) {
  if (member?.current === false) return;

  const lastActionAt = numberOrNull(member?.presence?.lastActionAt);
  if (!lastActionAt) return;

  const age = Math.max(0, now - lastActionAt);
  if (age < 2 * DAY) return;

  insights.push({
    code: 'inactive',
    kind: 'attention',
    metric: 'presence',
    value: age,
    comparisonValue: null,
    text: `No action recorded for ${formatDays(age)}.`
  });
}

function addWarParticipation(insights, member) {
  const current = member?.war?.last4 || {};
  const previous = member?.war?.previous4 || {};

  const currentAvailable = integer(current.warsAvailable);
  const currentParticipated = integer(current.warsParticipated);
  const currentParticipation = ratioOrNull(current.participation);

  if (currentAvailable >= 4 && currentParticipation !== null && currentParticipation <= 0.5) {
    insights.push({
      code: 'low_war_participation',
      kind: 'attention',
      metric: 'war',
      value: currentParticipation,
      comparisonValue: null,
      text: `Participated in ${currentParticipated} of the last ${currentAvailable} wars.`
    });
  }

  const previousAvailable = integer(previous.warsAvailable);
  const previousParticipation = ratioOrNull(previous.participation);

  if (
    currentAvailable >= 4 &&
    previousAvailable >= 4 &&
    currentParticipation !== null &&
    previousParticipation !== null &&
    previousParticipation - currentParticipation >= 0.5
  ) {
    insights.push({
      code: 'participation_down',
      kind: 'attention',
      metric: 'war',
      value: currentParticipation,
      comparisonValue: previousParticipation,
      text: `Participation fell from ${formatPercent(previousParticipation)} to ${formatPercent(currentParticipation)} versus the previous 4 wars.`
    });
  }
}

function addActivity(insights, member) {
  const metric = member?.activity || {};
  const current = numberOrNull(metric.perDay30d);
  const previous = numberOrNull(metric.perDayPrevious30d);
  const currentCoverage = numberOrNull(metric.coverageDays);
  const previousCoverage = numberOrNull(metric.previousCoverageDays ?? metric.coverageDaysPrevious30d);

  if (current === null || previous === null) return;

  if ((currentCoverage ?? 0) < 21 || (previousCoverage ?? 0) < 21) {
    insights.push({
      code: 'incomplete_activity_data',
      kind: 'note',
      metric: 'activity',
      value: currentCoverage,
      comparisonValue: previousCoverage,
      text: 'Activity trend is unavailable because the comparison windows are incomplete.'
    });
    return;
  }

  if (previous <= 0) return;

  const change = (current - previous) / previous;
  const absolute = current - previous;

  if (change <= -0.25 && absolute <= -3600) {
    insights.push({
      code: 'activity_down',
      kind: 'attention',
      metric: 'activity',
      value: current,
      comparisonValue: previous,
      text: `Activity/day is ${formatSignedPercent(change)} versus the previous 30 days.`
    });
  } else if (change >= 0.30 && absolute >= 3600) {
    insights.push({
      code: 'activity_up',
      kind: 'positive',
      metric: 'activity',
      value: current,
      comparisonValue: previous,
      text: `Activity/day is ${formatSignedPercent(change)} versus the previous 30 days.`
    });
  }
}

function addXanax(insights, member) {
  const metric = member?.xanax || {};
  const current = numberOrNull(metric.perDay30d);
  const previous = numberOrNull(metric.perDayPrevious30d);
  const currentCoverage = numberOrNull(metric.coverageDays);
  const previousCoverage = numberOrNull(metric.previousCoverageDays ?? metric.coverageDaysPrevious30d);

  if (current === null || previous === null) return;

  if ((currentCoverage ?? 0) < 21 || (previousCoverage ?? 0) < 21) {
    insights.push({
      code: 'incomplete_xanax_data',
      kind: 'note',
      metric: 'xanax',
      value: currentCoverage,
      comparisonValue: previousCoverage,
      text: 'Xanax trend is unavailable because the comparison windows are incomplete.'
    });
    return;
  }

  if (previous <= 0) return;

  const change = (current - previous) / previous;
  const absolute = current - previous;

  if (change <= -0.25 && absolute <= -0.5) {
    insights.push({
      code: 'xanax_down',
      kind: 'attention',
      metric: 'xanax',
      value: current,
      comparisonValue: previous,
      text: `Xanax/day is ${formatSignedPercent(change)} versus the previous 30 days.`
    });
  } else if (change >= 0.25 && absolute >= 0.5) {
    insights.push({
      code: 'xanax_up',
      kind: 'positive',
      metric: 'xanax',
      value: current,
      comparisonValue: previous,
      text: `Xanax/day is ${formatSignedPercent(change)} versus the previous 30 days.`
    });
  }
}

function addBattleStats(insights, member, now) {
  const stats = member?.battleStats || {};
  const value = numberOrNull(stats.value);

  if (value === null) {
    insights.push({
      code: 'missing_battle_stats',
      kind: 'attention',
      metric: 'battleStats',
      value: null,
      comparisonValue: null,
      text: 'No current battle-stat estimate is available.'
    });
    return;
  }

  const observedAt = numberOrNull(stats.observedAt);
  if (observedAt && now - observedAt > 21 * DAY) {
    insights.push({
      code: 'stale_battle_stats',
      kind: 'note',
      metric: 'battleStats',
      value: now - observedAt,
      comparisonValue: null,
      text: `Battle-stat estimate was last observed ${formatDays(now - observedAt)} ago.`
    });
  }

  const changePct = numberOrNull(stats.changePct30d);
  if (stats.trendReliable === true && changePct !== null && changePct >= 0.05) {
    insights.push({
      code: 'battle_stats_growth',
      kind: 'positive',
      metric: 'battleStats',
      value,
      comparisonValue: numberOrNull(stats.previousValue30d),
      text: `Battle stats increased by ${Math.round(changePct * 100)}% over 30 days.`
    });
  }
}

function addStrongWarOutput(insights, member, context) {
  const war = member?.war?.last4 || {};
  const participated = integer(war.warsParticipated);
  const hitsPerWar = numberOrNull(war.hitsPerWar);
  const netScore = numberOrNull(war.netScore);
  const medianHitsPerWar = numberOrNull(context?.factionMedianHitsPerWarLast4);

  if (
    participated >= 3 &&
    hitsPerWar !== null &&
    medianHitsPerWar !== null &&
    medianHitsPerWar > 0 &&
    hitsPerWar >= medianHitsPerWar * 1.25 &&
    netScore !== null &&
    netScore > 0
  ) {
    insights.push({
      code: 'strong_war_output',
      kind: 'positive',
      metric: 'war',
      value: hitsPerWar,
      comparisonValue: medianHitsPerWar,
      text: `Hits/war is ${Math.round((hitsPerWar / medianHitsPerWar - 1) * 100)}% above the faction median with positive net score.`
    });
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratioOrNull(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return Math.max(0, Math.min(1, number));
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatSignedPercent(value) {
  const percentage = Math.round(value * 100);
  return `${percentage > 0 ? '+' : ''}${percentage}%`;
}

function formatDays(seconds) {
  const days = Math.max(1, Math.floor(seconds / DAY));
  return `${days} day${days === 1 ? '' : 's'}`;
}
