export function compareDisplayNames(leftName, rightName, leftId = 0, rightId = 0) {
  const nameOrder = String(leftName || '').localeCompare(String(rightName || ''), undefined, {
    sensitivity:'base',
    numeric:true
  });
  if (nameOrder) return nameOrder;
  return Number(leftId || 0) - Number(rightId || 0);
}

export function sortFactionAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .slice()
    .sort((left, right) => compareDisplayNames(
      left.playerName || `Player ${left.playerId}`,
      right.playerName || `Player ${right.playerId}`,
      left.playerId,
      right.playerId
    ));
}

export function sortTrackedFactions(factions) {
  return (Array.isArray(factions) ? factions : [])
    .slice()
    .sort((left, right) => compareDisplayNames(
      left.factionName || `Faction ${left.factionId}`,
      right.factionName || `Faction ${right.factionId}`,
      left.factionId,
      right.factionId
    ));
}
