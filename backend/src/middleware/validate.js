/**
 * validate({ params, query, body }) - parses each part with a zod schema.
 * Parsed (and sanitised) values are exposed as req.valid.params / .query / .body.
 * Unknown body keys are stripped by zod, so clients cannot inject extra columns.
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      req.valid = {};
      if (schemas.params) req.valid.params = schemas.params.parse(req.params);
      if (schemas.query) req.valid.query = schemas.query.parse(req.query);
      if (schemas.body) req.valid.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validate };
