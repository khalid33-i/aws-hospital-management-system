/**
 * Pharmacy statistics shared by the Pharmacist dashboard and the Admin dashboard.
 * "Available" stock = units in batches that have NOT expired (expiry_date >= today).
 */
async function getPharmacyStats(db) {
  const [[stock]] = await db.query(`
    SELECT COUNT(*) AS total_medications,
           COALESCE(SUM(avail), 0) AS available_stock,
           COALESCE(SUM(avail <= reorder_level), 0) AS low_stock,
           COALESCE(SUM(avail = 0), 0) AS out_of_stock
    FROM (
      SELECT m.id, m.reorder_level,
             COALESCE(SUM(CASE WHEN i.expiry_date >= CURDATE() THEN i.quantity END), 0) AS avail
      FROM medications m
      LEFT JOIN pharmacy_inventory i ON i.medication_id = m.id
      WHERE m.is_active = 1
      GROUP BY m.id, m.reorder_level
    ) t`);

  const [[expired]] = await db.query(`
    SELECT COUNT(DISTINCT medication_id) AS expired_medications, COALESCE(SUM(quantity), 0) AS expired_units
    FROM pharmacy_inventory WHERE expiry_date < CURDATE() AND quantity > 0`);

  const [[soon]] = await db.query(`
    SELECT COUNT(*) AS expiring_soon_batches
    FROM pharmacy_inventory
    WHERE quantity > 0 AND expiry_date >= CURDATE() AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)`);

  const [rx] = await db.query('SELECT status, COUNT(*) AS count FROM prescriptions GROUP BY status');
  const byStatus = Object.fromEntries(rx.map((r) => [r.status, Number(r.count)]));

  const [[today]] = await db.query(
    'SELECT COUNT(DISTINCT request_key) AS dispensed_today FROM dispensing_records WHERE dispensed_at >= CURDATE()'
  );

  return {
    totalMedications: Number(stock.total_medications),
    availableStock: Number(stock.available_stock),
    lowStockMedications: Number(stock.low_stock),
    outOfStockMedications: Number(stock.out_of_stock),
    expiredMedications: Number(expired.expired_medications),
    expiredUnits: Number(expired.expired_units),
    expiringSoonBatches: Number(soon.expiring_soon_batches),
    pendingPrescriptions: byStatus.Pending || 0,
    partiallyDispensedPrescriptions: byStatus['Partially Dispensed'] || 0,
    completedPrescriptions: byStatus.Dispensed || 0,
    cancelledPrescriptions: byStatus.Cancelled || 0,
    dispensedToday: Number(today.dispensed_today),
  };
}

module.exports = { getPharmacyStats };
