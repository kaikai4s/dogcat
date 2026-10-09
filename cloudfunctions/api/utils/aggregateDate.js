// Historical local timestamps are Beijing time; explicit zones remain authoritative.
function aggregateDate(field) {
  const value = `$${field}`
  return { $cond: [{ $eq: [{ $type: value }, 'date'] }, value, {
    $cond: [{ $eq: [{ $type: value }, 'string'] }, {
      $cond: [{ $or: ['Z', 'z', '+', '-'].map(token => ({ $gte: [{ $indexOfBytes: [value, token, 10] }, 0] })) },
        { $dateFromString: { dateString: value, onError: null, onNull: null } },
        { $dateFromString: { dateString: value, timezone: '+08:00', onError: null, onNull: null } }]
    }, { $cond: [{ $in: [{ $type: value }, ['int', 'long', 'double']] }, { $toDate: value }, null] }]
  }] }
}
module.exports = aggregateDate
