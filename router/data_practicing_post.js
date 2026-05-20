const express = require("express");
const router = express.Router();

module.exports = (jsonParser) => {
  router.post("/test", jsonParser, (req, res) => {
    console.log("test success from router");
    res.status(200).send({ data: "output from router" });
  });

  // QUAN TRỌNG: Phải return router
  return router;
};
