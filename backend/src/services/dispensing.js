const { withTransaction } = require('../config/db');
const { badRequest, notFound, conflict } = require('../utils/httpError');
const { writeAudit } = require('../utils/helpers');

/**
 * Dispense (part of) a prescription. Everything below happens in ONE database transaction:
 * either every stock deduction + dispensing record + status update is saved, or nothing is.
 *
 * Business rules enforced here (and backed up by CHECK constraints in the schema):
 *  1. Expired batches are never used (query filters expiry_date >= today).
 *  2. Stock never goes negative (guarded UPDATE + CHECK constraint).
 *  3. Cannot dispense more than the available (non-expired) stock.
 *  4. Cannot dispense more than the quantity prescribed.
 *  5. Duplicate requests (retry / double click) are ignored via the idempotency key (requestKey).
 *  6. Concurrent pharmacists cannot race: rows are locked with SELECT ... FOR UPDATE.
 *  7. Pharmacists never edit a prescription; only quantity_dispensed and status change, via this function.
 */
async function dispensePrescription({ prescriptionId, pharmacistId, userId, requestKey, items, ip }) {
  return withTransaction(async (conn) => {
    // Lock the prescription row: concurrent dispensing of the same prescription is serialised.
    const [rxRows] = await conn.query('SELECT id, status FROM prescriptions WHERE id = ? FOR UPDATE', [prescriptionId]);
    const rx = rxRows[0];
    if (!rx) throw notFound('Prescription not found');

    // Idempotency: the same request key means "this click was already processed".
    const [seen] = await conn.query(
      `SELECT DISTINCT pi.prescription_id
       FROM dispensing_records dr JOIN prescription_items pi ON pi.id = dr.prescription_item_id
       WHERE dr.request_key = ?`,
      [requestKey]
    );
    if (seen.length) {
      if (seen[0].prescription_id !== prescriptionId) {
        throw conflict('This request key was already used for a different prescription', 'INVALID_REQUEST_KEY');
      }
      return { duplicate: true, prescriptionId, status: rx.status, dispensed: [] };
    }

    if (rx.status === 'Cancelled') throw conflict('This prescription was cancelled', 'PRESCRIPTION_CANCELLED');
    if (rx.status === 'Dispensed') throw conflict('This prescription is already fully dispensed', 'ALREADY_DISPENSED');

    const requested = [...items].sort((a, b) => a.itemId - b.itemId); // consistent lock order
    const itemIds = requested.map((i) => i.itemId);
    const [itemRows] = await conn.query(
      `SELECT id, medication_id, quantity_prescribed, quantity_dispensed
       FROM prescription_items WHERE prescription_id = ? AND id IN (?) ORDER BY id FOR UPDATE`,
      [prescriptionId, itemIds]
    );
    if (itemRows.length !== itemIds.length) {
      throw badRequest('One or more items do not belong to this prescription');
    }
    const itemById = new Map(itemRows.map((r) => [r.id, r]));

    const [medRows] = await conn.query('SELECT id, name, strength, is_active, unit_price FROM medications WHERE id IN (?)', [
      [...new Set(itemRows.map((r) => r.medication_id))],
    ]);
    const medById = new Map(medRows.map((m) => [m.id, m]));

    const dispensed = [];
    for (const req of requested) {
      const item = itemById.get(req.itemId);
      const med = medById.get(item.medication_id);
      const label = `${med.name} ${med.strength}`;
      const remaining = item.quantity_prescribed - item.quantity_dispensed;

      if (!med.is_active) throw conflict(`${label} is deactivated and cannot be dispensed`, 'MEDICATION_INACTIVE');
      if (remaining <= 0) throw conflict(`${label} was already fully dispensed`, 'ALREADY_DISPENSED');
      if (req.quantity > remaining) {
        throw conflict(`Cannot dispense ${req.quantity} of ${label}: only ${remaining} remaining on the prescription`, 'EXCEEDS_PRESCRIBED', {
          itemId: item.id,
          remaining,
        });
      }

      // First-Expiry-First-Out over NON-expired batches, rows locked for the rest of the transaction.
      const [batches] = await conn.query(
        `SELECT id, batch_no, quantity FROM pharmacy_inventory
         WHERE medication_id = ? AND quantity > 0 AND expiry_date >= CURDATE()
         ORDER BY expiry_date, id FOR UPDATE`,
        [med.id]
      );
      const available = batches.reduce((sum, b) => sum + b.quantity, 0);
      if (available < req.quantity) {
        const [[exp]] = await conn.query(
          'SELECT COALESCE(SUM(quantity), 0) AS units FROM pharmacy_inventory WHERE medication_id = ? AND expiry_date < CURDATE() AND quantity > 0',
          [med.id]
        );
        const message =
          available === 0 && Number(exp.units) > 0
            ? `${label}: the only stock on hand has expired and cannot be dispensed`
            : `Insufficient stock for ${label}: requested ${req.quantity}, available ${available}`;
        throw conflict(message, 'INSUFFICIENT_STOCK', { itemId: item.id, requested: req.quantity, available, expiredUnits: Number(exp.units) });
      }

      let toTake = req.quantity;
      const used = [];
      for (const batch of batches) {
        if (toTake === 0) break;
        const take = Math.min(batch.quantity, toTake);
        const [upd] = await conn.query('UPDATE pharmacy_inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?', [take, batch.id, take]);
        if (upd.affectedRows !== 1) throw conflict(`Stock for ${label} changed, please retry`, 'STOCK_CHANGED');
        await conn.query(
          `INSERT INTO dispensing_records (prescription_item_id, inventory_id, pharmacist_id, quantity, unit_price, request_key)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [item.id, batch.id, pharmacistId, take, med.unit_price, requestKey]
        );
        used.push({ batchNo: batch.batch_no, quantity: take });
        toTake -= take;
      }

      const [itemUpd] = await conn.query(
        'UPDATE prescription_items SET quantity_dispensed = quantity_dispensed + ? WHERE id = ? AND quantity_dispensed + ? <= quantity_prescribed',
        [req.quantity, item.id, req.quantity]
      );
      if (itemUpd.affectedRows !== 1) throw conflict('Prescription changed, please retry', 'PRESCRIPTION_CHANGED');

      dispensed.push({ itemId: item.id, medication: label, quantity: req.quantity, batches: used });
    }

    const [[left]] = await conn.query(
      'SELECT COALESCE(SUM(quantity_prescribed - quantity_dispensed), 0) AS remaining FROM prescription_items WHERE prescription_id = ?',
      [prescriptionId]
    );
    const status = Number(left.remaining) === 0 ? 'Dispensed' : 'Partially Dispensed';
    await conn.query('UPDATE prescriptions SET status = ? WHERE id = ?', [status, prescriptionId]);

    await writeAudit(conn, {
      userId,
      action: 'PRESCRIPTION_DISPENSED',
      entityType: 'prescription',
      entityId: prescriptionId,
      details: { requestKey, status, items: dispensed.map((d) => ({ itemId: d.itemId, quantity: d.quantity })) },
      ip,
    });

    return { duplicate: false, prescriptionId, status, dispensed };
  });
}

module.exports = { dispensePrescription };
