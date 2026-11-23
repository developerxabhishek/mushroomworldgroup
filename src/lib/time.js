const { IST_OFFSET_MS } = require('../config');

/** Today's calendar date in IST, as 'YYYY-MM-DD'. */
function todayIST(now) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 23:59:59 IST on the delivery date, as an absolute instant. */
function endOfDeliveryDayIST(deliveryDate) {
  return new Date(`${deliveryDate}T23:59:59+05:30`);
}

module.exports = { todayIST, endOfDeliveryDayIST };
