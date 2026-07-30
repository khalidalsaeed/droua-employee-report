/* Add a new entry here to support a new document type (e.g. insurance, passport, contract). */
module.exports = [
  { key: "iqama", label: "الإقامة", getExpiry: (emp) => emp.iqExp },
  { key: "license", label: "رخصة العمل", getExpiry: (emp) => emp.licExp },
];
