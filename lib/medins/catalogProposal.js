/* ─── قائمة بنود المنافع المقترحة — للمراجعة، لا مزروعة ──────────────────
   =========================================================================
   ⛔ هذه **مسودّة** تنتظر اعتمادك. لا تُزرع في أي قاعدة إلا بتشغيل صريح:
        node scripts/seed-medins-catalog.js --apply
   والكتالوج نفسه بيانات: أيّ بند يُضاف أو يُعطَّل أو يُعاد تسميته من
   الواجهة (الإعدادات ← الكتالوج) بلا هجرة ولا نشر.

   مبادئ القائمة:
   • بندٌ واحد = قيمةٌ واحدة بنوعٍ واحد. «التحمّل 20% بحدٍّ أقصى 75 ريالًا»
     بندان (نسبة + مبلغ)، لا نصٌّ واحد يتعذّر مقارنته.
   • «الاستثناءات والملاحظات الخاصّة» ليست بندًا هنا: مكانها جدول الشروط
     (medins_offer_terms) نصوصًا حرّة بخطورة ومصدر.
   • `better` يحدّد اتّجاه المقارنة في Phase 2 صراحةً — لا يُخمَّن من الاسم.
   • لا افتراض أن كل عرض يذكر كل بند: الغائب يبقى «غير معروف». */

const PROPOSAL = Object.freeze([
  { code: "annual_limit", labelAr: "الحد السنوي للمستفيد", labelEn: "Annual limit per member", category: "limits", valueType: "amount", unit: "SAR", better: "higher" },
  { code: "inpatient_covered", labelAr: "التنويم مغطّى", labelEn: "Inpatient covered", category: "inpatient", valueType: "boolean", unit: null, better: "higher" },
  { code: "room_type", labelAr: "نوع الغرفة / الإقامة", labelEn: "Room / accommodation", category: "inpatient", valueType: "text", unit: null, better: "none" },
  { code: "inpatient_copay_pct", labelAr: "نسبة التحمّل في التنويم", labelEn: "Inpatient co-pay %", category: "cost_sharing", valueType: "percent", unit: "percent", better: "lower" },
  { code: "outpatient_covered", labelAr: "العيادات الخارجية مغطّاة", labelEn: "Outpatient covered", category: "outpatient", valueType: "boolean", unit: null, better: "higher" },
  { code: "outpatient_copay_pct", labelAr: "نسبة التحمّل في العيادات الخارجية", labelEn: "Outpatient co-pay %", category: "cost_sharing", valueType: "percent", unit: "percent", better: "lower" },
  { code: "copay_cap_per_visit", labelAr: "الحد الأعلى للتحمّل للزيارة", labelEn: "Co-pay cap per visit", category: "cost_sharing", valueType: "amount", unit: "SAR", better: "lower" },
  { code: "emergency_covered", labelAr: "الطوارئ مغطّاة", labelEn: "Emergency covered", category: "emergency", valueType: "boolean", unit: null, better: "higher" },
  { code: "dental_limit", labelAr: "حد الأسنان", labelEn: "Dental limit", category: "dental", valueType: "amount", unit: "SAR", better: "higher" },
  { code: "optical_limit", labelAr: "حد النظارات", labelEn: "Optical limit", category: "optical", valueType: "amount", unit: "SAR", better: "higher" },
  { code: "maternity_limit", labelAr: "حد الحمل والولادة", labelEn: "Maternity limit", category: "maternity", valueType: "amount", unit: "SAR", better: "higher" },
  { code: "chronic_covered", labelAr: "الأمراض المزمنة مغطّاة", labelEn: "Chronic conditions covered", category: "chronic", valueType: "boolean", unit: null, better: "higher" },
  { code: "preexisting_covered", labelAr: "الأمراض السابقة / القائمة مغطّاة", labelEn: "Pre-existing conditions covered", category: "chronic", valueType: "boolean", unit: null, better: "higher" },
  { code: "physiotherapy_sessions", labelAr: "جلسات العلاج الطبيعي في السنة", labelEn: "Physiotherapy sessions / year", category: "therapy", valueType: "count", unit: "session", better: "higher" },
  { code: "pharmacy_copay_pct", labelAr: "نسبة التحمّل في الأدوية", labelEn: "Pharmacy co-pay %", category: "pharmacy", valueType: "percent", unit: "percent", better: "lower" },
  { code: "mental_health_covered", labelAr: "العلاج النفسي مغطّى", labelEn: "Mental health covered", category: "mental_health", valueType: "boolean", unit: null, better: "higher" },
  { code: "medical_evacuation_covered", labelAr: "الإخلاء الطبي مغطّى", labelEn: "Medical evacuation covered", category: "evacuation", valueType: "boolean", unit: null, better: "higher" },
  { code: "out_of_network_covered", labelAr: "التغطية خارج الشبكة", labelEn: "Out-of-network coverage", category: "network", valueType: "boolean", unit: null, better: "higher" },
].map((item, i) => Object.freeze({ ...item, displayOrder: (i + 1) * 10 })));

module.exports = { PROPOSAL };
