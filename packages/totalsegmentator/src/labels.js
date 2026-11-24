// Anatomical label maps, multi-part LUTs and NiiVue colormaps for TotalSegmentator v2.
// Class IDs match upstream wasserth/TotalSegmentator map_to_binary.py exactly.

export const GROUP_LABELS = Object.freeze({
  organs: 'Organs',
  vertebrae: 'Vertebrae',
  cardiac: 'Cardiac & vessels',
  muscles: 'Muscles & bones',
  ribs: 'Ribs',
  abdominal_muscles: 'Abdominal muscles',
  body: 'Body',
});

export const TOTAL_CT_LABELS = Object.freeze([
  Object.freeze({ id: 1, slug: "spleen", name: "Spleen", group: "organs" }),
  Object.freeze({ id: 2, slug: "kidney_right", name: "Kidney right", group: "organs" }),
  Object.freeze({ id: 3, slug: "kidney_left", name: "Kidney left", group: "organs" }),
  Object.freeze({ id: 4, slug: "gallbladder", name: "Gallbladder", group: "organs" }),
  Object.freeze({ id: 5, slug: "liver", name: "Liver", group: "organs" }),
  Object.freeze({ id: 6, slug: "stomach", name: "Stomach", group: "organs" }),
  Object.freeze({ id: 7, slug: "pancreas", name: "Pancreas", group: "organs" }),
  Object.freeze({ id: 8, slug: "adrenal_gland_right", name: "Adrenal gland right", group: "organs" }),
  Object.freeze({ id: 9, slug: "adrenal_gland_left", name: "Adrenal gland left", group: "organs" }),
  Object.freeze({ id: 10, slug: "lung_upper_lobe_left", name: "Lung upper lobe left", group: "organs" }),
  Object.freeze({ id: 11, slug: "lung_lower_lobe_left", name: "Lung lower lobe left", group: "organs" }),
  Object.freeze({ id: 12, slug: "lung_upper_lobe_right", name: "Lung upper lobe right", group: "organs" }),
  Object.freeze({ id: 13, slug: "lung_middle_lobe_right", name: "Lung middle lobe right", group: "organs" }),
  Object.freeze({ id: 14, slug: "lung_lower_lobe_right", name: "Lung lower lobe right", group: "organs" }),
  Object.freeze({ id: 15, slug: "esophagus", name: "Esophagus", group: "organs" }),
  Object.freeze({ id: 16, slug: "trachea", name: "Trachea", group: "organs" }),
  Object.freeze({ id: 17, slug: "thyroid_gland", name: "Thyroid gland", group: "organs" }),
  Object.freeze({ id: 18, slug: "small_bowel", name: "Small bowel", group: "organs" }),
  Object.freeze({ id: 19, slug: "duodenum", name: "Duodenum", group: "organs" }),
  Object.freeze({ id: 20, slug: "colon", name: "Colon", group: "organs" }),
  Object.freeze({ id: 21, slug: "urinary_bladder", name: "Urinary bladder", group: "organs" }),
  Object.freeze({ id: 22, slug: "prostate", name: "Prostate", group: "organs" }),
  Object.freeze({ id: 23, slug: "kidney_cyst_left", name: "Kidney cyst left", group: "organs" }),
  Object.freeze({ id: 24, slug: "kidney_cyst_right", name: "Kidney cyst right", group: "organs" }),
  Object.freeze({ id: 25, slug: "sacrum", name: "Sacrum", group: "vertebrae" }),
  Object.freeze({ id: 26, slug: "vertebrae_S1", name: "Vertebrae S1", group: "vertebrae" }),
  Object.freeze({ id: 27, slug: "vertebrae_L5", name: "Vertebrae L5", group: "vertebrae" }),
  Object.freeze({ id: 28, slug: "vertebrae_L4", name: "Vertebrae L4", group: "vertebrae" }),
  Object.freeze({ id: 29, slug: "vertebrae_L3", name: "Vertebrae L3", group: "vertebrae" }),
  Object.freeze({ id: 30, slug: "vertebrae_L2", name: "Vertebrae L2", group: "vertebrae" }),
  Object.freeze({ id: 31, slug: "vertebrae_L1", name: "Vertebrae L1", group: "vertebrae" }),
  Object.freeze({ id: 32, slug: "vertebrae_T12", name: "Vertebrae T12", group: "vertebrae" }),
  Object.freeze({ id: 33, slug: "vertebrae_T11", name: "Vertebrae T11", group: "vertebrae" }),
  Object.freeze({ id: 34, slug: "vertebrae_T10", name: "Vertebrae T10", group: "vertebrae" }),
  Object.freeze({ id: 35, slug: "vertebrae_T9", name: "Vertebrae T9", group: "vertebrae" }),
  Object.freeze({ id: 36, slug: "vertebrae_T8", name: "Vertebrae T8", group: "vertebrae" }),
  Object.freeze({ id: 37, slug: "vertebrae_T7", name: "Vertebrae T7", group: "vertebrae" }),
  Object.freeze({ id: 38, slug: "vertebrae_T6", name: "Vertebrae T6", group: "vertebrae" }),
  Object.freeze({ id: 39, slug: "vertebrae_T5", name: "Vertebrae T5", group: "vertebrae" }),
  Object.freeze({ id: 40, slug: "vertebrae_T4", name: "Vertebrae T4", group: "vertebrae" }),
  Object.freeze({ id: 41, slug: "vertebrae_T3", name: "Vertebrae T3", group: "vertebrae" }),
  Object.freeze({ id: 42, slug: "vertebrae_T2", name: "Vertebrae T2", group: "vertebrae" }),
  Object.freeze({ id: 43, slug: "vertebrae_T1", name: "Vertebrae T1", group: "vertebrae" }),
  Object.freeze({ id: 44, slug: "vertebrae_C7", name: "Vertebrae C7", group: "vertebrae" }),
  Object.freeze({ id: 45, slug: "vertebrae_C6", name: "Vertebrae C6", group: "vertebrae" }),
  Object.freeze({ id: 46, slug: "vertebrae_C5", name: "Vertebrae C5", group: "vertebrae" }),
  Object.freeze({ id: 47, slug: "vertebrae_C4", name: "Vertebrae C4", group: "vertebrae" }),
  Object.freeze({ id: 48, slug: "vertebrae_C3", name: "Vertebrae C3", group: "vertebrae" }),
  Object.freeze({ id: 49, slug: "vertebrae_C2", name: "Vertebrae C2", group: "vertebrae" }),
  Object.freeze({ id: 50, slug: "vertebrae_C1", name: "Vertebrae C1", group: "vertebrae" }),
  Object.freeze({ id: 51, slug: "heart", name: "Heart", group: "cardiac" }),
  Object.freeze({ id: 52, slug: "aorta", name: "Aorta", group: "cardiac" }),
  Object.freeze({ id: 53, slug: "pulmonary_vein", name: "Pulmonary vein", group: "cardiac" }),
  Object.freeze({ id: 54, slug: "brachiocephalic_trunk", name: "Brachiocephalic trunk", group: "cardiac" }),
  Object.freeze({ id: 55, slug: "subclavian_artery_right", name: "Subclavian artery right", group: "cardiac" }),
  Object.freeze({ id: 56, slug: "subclavian_artery_left", name: "Subclavian artery left", group: "cardiac" }),
  Object.freeze({ id: 57, slug: "common_carotid_artery_right", name: "Common carotid artery right", group: "cardiac" }),
  Object.freeze({ id: 58, slug: "common_carotid_artery_left", name: "Common carotid artery left", group: "cardiac" }),
  Object.freeze({ id: 59, slug: "brachiocephalic_vein_left", name: "Brachiocephalic vein left", group: "cardiac" }),
  Object.freeze({ id: 60, slug: "brachiocephalic_vein_right", name: "Brachiocephalic vein right", group: "cardiac" }),
  Object.freeze({ id: 61, slug: "atrial_appendage_left", name: "Atrial appendage left", group: "cardiac" }),
  Object.freeze({ id: 62, slug: "superior_vena_cava", name: "Superior vena cava", group: "cardiac" }),
  Object.freeze({ id: 63, slug: "inferior_vena_cava", name: "Inferior vena cava", group: "cardiac" }),
  Object.freeze({ id: 64, slug: "portal_vein_and_splenic_vein", name: "Portal vein and splenic vein", group: "cardiac" }),
  Object.freeze({ id: 65, slug: "iliac_artery_left", name: "Iliac artery left", group: "cardiac" }),
  Object.freeze({ id: 66, slug: "iliac_artery_right", name: "Iliac artery right", group: "cardiac" }),
  Object.freeze({ id: 67, slug: "iliac_vena_left", name: "Iliac vena left", group: "cardiac" }),
  Object.freeze({ id: 68, slug: "iliac_vena_right", name: "Iliac vena right", group: "cardiac" }),
  Object.freeze({ id: 69, slug: "humerus_left", name: "Humerus left", group: "muscles" }),
  Object.freeze({ id: 70, slug: "humerus_right", name: "Humerus right", group: "muscles" }),
  Object.freeze({ id: 71, slug: "scapula_left", name: "Scapula left", group: "muscles" }),
  Object.freeze({ id: 72, slug: "scapula_right", name: "Scapula right", group: "muscles" }),
  Object.freeze({ id: 73, slug: "clavicula_left", name: "Clavicula left", group: "muscles" }),
  Object.freeze({ id: 74, slug: "clavicula_right", name: "Clavicula right", group: "muscles" }),
  Object.freeze({ id: 75, slug: "femur_left", name: "Femur left", group: "muscles" }),
  Object.freeze({ id: 76, slug: "femur_right", name: "Femur right", group: "muscles" }),
  Object.freeze({ id: 77, slug: "hip_left", name: "Hip left", group: "muscles" }),
  Object.freeze({ id: 78, slug: "hip_right", name: "Hip right", group: "muscles" }),
  Object.freeze({ id: 79, slug: "spinal_cord", name: "Spinal cord", group: "muscles" }),
  Object.freeze({ id: 80, slug: "gluteus_maximus_left", name: "Gluteus maximus left", group: "muscles" }),
  Object.freeze({ id: 81, slug: "gluteus_maximus_right", name: "Gluteus maximus right", group: "muscles" }),
  Object.freeze({ id: 82, slug: "gluteus_medius_left", name: "Gluteus medius left", group: "muscles" }),
  Object.freeze({ id: 83, slug: "gluteus_medius_right", name: "Gluteus medius right", group: "muscles" }),
  Object.freeze({ id: 84, slug: "gluteus_minimus_left", name: "Gluteus minimus left", group: "muscles" }),
  Object.freeze({ id: 85, slug: "gluteus_minimus_right", name: "Gluteus minimus right", group: "muscles" }),
  Object.freeze({ id: 86, slug: "autochthon_left", name: "Autochthon left", group: "muscles" }),
  Object.freeze({ id: 87, slug: "autochthon_right", name: "Autochthon right", group: "muscles" }),
  Object.freeze({ id: 88, slug: "iliopsoas_left", name: "Iliopsoas left", group: "muscles" }),
  Object.freeze({ id: 89, slug: "iliopsoas_right", name: "Iliopsoas right", group: "muscles" }),
  Object.freeze({ id: 90, slug: "brain", name: "Brain", group: "muscles" }),
  Object.freeze({ id: 91, slug: "skull", name: "Skull", group: "muscles" }),
  Object.freeze({ id: 92, slug: "rib_left_1", name: "Rib left 1", group: "ribs" }),
  Object.freeze({ id: 93, slug: "rib_left_2", name: "Rib left 2", group: "ribs" }),
  Object.freeze({ id: 94, slug: "rib_left_3", name: "Rib left 3", group: "ribs" }),
  Object.freeze({ id: 95, slug: "rib_left_4", name: "Rib left 4", group: "ribs" }),
  Object.freeze({ id: 96, slug: "rib_left_5", name: "Rib left 5", group: "ribs" }),
  Object.freeze({ id: 97, slug: "rib_left_6", name: "Rib left 6", group: "ribs" }),
  Object.freeze({ id: 98, slug: "rib_left_7", name: "Rib left 7", group: "ribs" }),
  Object.freeze({ id: 99, slug: "rib_left_8", name: "Rib left 8", group: "ribs" }),
  Object.freeze({ id: 100, slug: "rib_left_9", name: "Rib left 9", group: "ribs" }),
  Object.freeze({ id: 101, slug: "rib_left_10", name: "Rib left 10", group: "ribs" }),
  Object.freeze({ id: 102, slug: "rib_left_11", name: "Rib left 11", group: "ribs" }),
  Object.freeze({ id: 103, slug: "rib_left_12", name: "Rib left 12", group: "ribs" }),
  Object.freeze({ id: 104, slug: "rib_right_1", name: "Rib right 1", group: "ribs" }),
  Object.freeze({ id: 105, slug: "rib_right_2", name: "Rib right 2", group: "ribs" }),
  Object.freeze({ id: 106, slug: "rib_right_3", name: "Rib right 3", group: "ribs" }),
  Object.freeze({ id: 107, slug: "rib_right_4", name: "Rib right 4", group: "ribs" }),
  Object.freeze({ id: 108, slug: "rib_right_5", name: "Rib right 5", group: "ribs" }),
  Object.freeze({ id: 109, slug: "rib_right_6", name: "Rib right 6", group: "ribs" }),
  Object.freeze({ id: 110, slug: "rib_right_7", name: "Rib right 7", group: "ribs" }),
  Object.freeze({ id: 111, slug: "rib_right_8", name: "Rib right 8", group: "ribs" }),
  Object.freeze({ id: 112, slug: "rib_right_9", name: "Rib right 9", group: "ribs" }),
  Object.freeze({ id: 113, slug: "rib_right_10", name: "Rib right 10", group: "ribs" }),
  Object.freeze({ id: 114, slug: "rib_right_11", name: "Rib right 11", group: "ribs" }),
  Object.freeze({ id: 115, slug: "rib_right_12", name: "Rib right 12", group: "ribs" }),
  Object.freeze({ id: 116, slug: "sternum", name: "Sternum", group: "ribs" }),
  Object.freeze({ id: 117, slug: "costal_cartilages", name: "Costal cartilages", group: "ribs" }),
]);

export const TOTAL_MR_LABELS = Object.freeze([
  Object.freeze({ id: 1, slug: "spleen", name: "Spleen", group: "organs" }),
  Object.freeze({ id: 2, slug: "kidney_right", name: "Kidney right", group: "organs" }),
  Object.freeze({ id: 3, slug: "kidney_left", name: "Kidney left", group: "organs" }),
  Object.freeze({ id: 4, slug: "gallbladder", name: "Gallbladder", group: "organs" }),
  Object.freeze({ id: 5, slug: "liver", name: "Liver", group: "organs" }),
  Object.freeze({ id: 6, slug: "stomach", name: "Stomach", group: "organs" }),
  Object.freeze({ id: 7, slug: "pancreas", name: "Pancreas", group: "organs" }),
  Object.freeze({ id: 8, slug: "adrenal_gland_right", name: "Adrenal gland right", group: "organs" }),
  Object.freeze({ id: 9, slug: "adrenal_gland_left", name: "Adrenal gland left", group: "organs" }),
  Object.freeze({ id: 10, slug: "lung_left", name: "Lung left", group: "organs" }),
  Object.freeze({ id: 11, slug: "lung_right", name: "Lung right", group: "organs" }),
  Object.freeze({ id: 12, slug: "esophagus", name: "Esophagus", group: "organs" }),
  Object.freeze({ id: 13, slug: "small_bowel", name: "Small bowel", group: "organs" }),
  Object.freeze({ id: 14, slug: "duodenum", name: "Duodenum", group: "organs" }),
  Object.freeze({ id: 15, slug: "colon", name: "Colon", group: "organs" }),
  Object.freeze({ id: 16, slug: "urinary_bladder", name: "Urinary bladder", group: "organs" }),
  Object.freeze({ id: 17, slug: "prostate", name: "Prostate", group: "organs" }),
  Object.freeze({ id: 18, slug: "sacrum", name: "Sacrum", group: "organs" }),
  Object.freeze({ id: 19, slug: "vertebrae", name: "Vertebrae", group: "organs" }),
  Object.freeze({ id: 20, slug: "intervertebral_discs", name: "Intervertebral discs", group: "organs" }),
  Object.freeze({ id: 21, slug: "spinal_cord", name: "Spinal cord", group: "organs" }),
  Object.freeze({ id: 22, slug: "heart", name: "Heart", group: "organs" }),
  Object.freeze({ id: 23, slug: "aorta", name: "Aorta", group: "organs" }),
  Object.freeze({ id: 24, slug: "inferior_vena_cava", name: "Inferior vena cava", group: "organs" }),
  Object.freeze({ id: 25, slug: "portal_vein_and_splenic_vein", name: "Portal vein and splenic vein", group: "organs" }),
  Object.freeze({ id: 26, slug: "iliac_artery_left", name: "Iliac artery left", group: "organs" }),
  Object.freeze({ id: 27, slug: "iliac_artery_right", name: "Iliac artery right", group: "organs" }),
  Object.freeze({ id: 28, slug: "iliac_vena_left", name: "Iliac vena left", group: "organs" }),
  Object.freeze({ id: 29, slug: "iliac_vena_right", name: "Iliac vena right", group: "organs" }),
  Object.freeze({ id: 30, slug: "humerus_left", name: "Humerus left", group: "muscles" }),
  Object.freeze({ id: 31, slug: "humerus_right", name: "Humerus right", group: "muscles" }),
  Object.freeze({ id: 32, slug: "scapula_left", name: "Scapula left", group: "muscles" }),
  Object.freeze({ id: 33, slug: "scapula_right", name: "Scapula right", group: "muscles" }),
  Object.freeze({ id: 34, slug: "clavicula_left", name: "Clavicula left", group: "muscles" }),
  Object.freeze({ id: 35, slug: "clavicula_right", name: "Clavicula right", group: "muscles" }),
  Object.freeze({ id: 36, slug: "femur_left", name: "Femur left", group: "muscles" }),
  Object.freeze({ id: 37, slug: "femur_right", name: "Femur right", group: "muscles" }),
  Object.freeze({ id: 38, slug: "hip_left", name: "Hip left", group: "muscles" }),
  Object.freeze({ id: 39, slug: "hip_right", name: "Hip right", group: "muscles" }),
  Object.freeze({ id: 40, slug: "gluteus_maximus_left", name: "Gluteus maximus left", group: "muscles" }),
  Object.freeze({ id: 41, slug: "gluteus_maximus_right", name: "Gluteus maximus right", group: "muscles" }),
  Object.freeze({ id: 42, slug: "gluteus_medius_left", name: "Gluteus medius left", group: "muscles" }),
  Object.freeze({ id: 43, slug: "gluteus_medius_right", name: "Gluteus medius right", group: "muscles" }),
  Object.freeze({ id: 44, slug: "gluteus_minimus_left", name: "Gluteus minimus left", group: "muscles" }),
  Object.freeze({ id: 45, slug: "gluteus_minimus_right", name: "Gluteus minimus right", group: "muscles" }),
  Object.freeze({ id: 46, slug: "autochthon_left", name: "Autochthon left", group: "muscles" }),
  Object.freeze({ id: 47, slug: "autochthon_right", name: "Autochthon right", group: "muscles" }),
  Object.freeze({ id: 48, slug: "iliopsoas_left", name: "Iliopsoas left", group: "muscles" }),
  Object.freeze({ id: 49, slug: "iliopsoas_right", name: "Iliopsoas right", group: "muscles" }),
  Object.freeze({ id: 50, slug: "brain", name: "Brain", group: "muscles" }),
]);

export const VERTEBRAE_MR_LABELS = Object.freeze([
  Object.freeze({ id: 1, slug: "sacrum", name: "Sacrum", group: "vertebrae" }),
  Object.freeze({ id: 2, slug: "vertebrae_L5", name: "Vertebrae L5", group: "vertebrae" }),
  Object.freeze({ id: 3, slug: "vertebrae_L4", name: "Vertebrae L4", group: "vertebrae" }),
  Object.freeze({ id: 4, slug: "vertebrae_L3", name: "Vertebrae L3", group: "vertebrae" }),
  Object.freeze({ id: 5, slug: "vertebrae_L2", name: "Vertebrae L2", group: "vertebrae" }),
  Object.freeze({ id: 6, slug: "vertebrae_L1", name: "Vertebrae L1", group: "vertebrae" }),
  Object.freeze({ id: 7, slug: "vertebrae_T12", name: "Vertebrae T12", group: "vertebrae" }),
  Object.freeze({ id: 8, slug: "vertebrae_T11", name: "Vertebrae T11", group: "vertebrae" }),
  Object.freeze({ id: 9, slug: "vertebrae_T10", name: "Vertebrae T10", group: "vertebrae" }),
  Object.freeze({ id: 10, slug: "vertebrae_T9", name: "Vertebrae T9", group: "vertebrae" }),
  Object.freeze({ id: 11, slug: "vertebrae_T8", name: "Vertebrae T8", group: "vertebrae" }),
  Object.freeze({ id: 12, slug: "vertebrae_T7", name: "Vertebrae T7", group: "vertebrae" }),
  Object.freeze({ id: 13, slug: "vertebrae_T6", name: "Vertebrae T6", group: "vertebrae" }),
  Object.freeze({ id: 14, slug: "vertebrae_T5", name: "Vertebrae T5", group: "vertebrae" }),
  Object.freeze({ id: 15, slug: "vertebrae_T4", name: "Vertebrae T4", group: "vertebrae" }),
  Object.freeze({ id: 16, slug: "vertebrae_T3", name: "Vertebrae T3", group: "vertebrae" }),
  Object.freeze({ id: 17, slug: "vertebrae_T2", name: "Vertebrae T2", group: "vertebrae" }),
  Object.freeze({ id: 18, slug: "vertebrae_T1", name: "Vertebrae T1", group: "vertebrae" }),
  Object.freeze({ id: 19, slug: "vertebrae_C7", name: "Vertebrae C7", group: "vertebrae" }),
  Object.freeze({ id: 20, slug: "vertebrae_C6", name: "Vertebrae C6", group: "vertebrae" }),
  Object.freeze({ id: 21, slug: "vertebrae_C5", name: "Vertebrae C5", group: "vertebrae" }),
  Object.freeze({ id: 22, slug: "vertebrae_C4", name: "Vertebrae C4", group: "vertebrae" }),
  Object.freeze({ id: 23, slug: "vertebrae_C3", name: "Vertebrae C3", group: "vertebrae" }),
  Object.freeze({ id: 24, slug: "vertebrae_C2", name: "Vertebrae C2", group: "vertebrae" }),
  Object.freeze({ id: 25, slug: "vertebrae_C1", name: "Vertebrae C1", group: "vertebrae" }),
]);

export const ABDOMINAL_MUSCLES_LABELS = Object.freeze([
  Object.freeze({ id: 1, slug: "pectoralis_major_right", name: "Pectoralis major right", group: "abdominal_muscles" }),
  Object.freeze({ id: 2, slug: "pectoralis_major_left", name: "Pectoralis major left", group: "abdominal_muscles" }),
  Object.freeze({ id: 3, slug: "rectus_abdominis_right", name: "Rectus abdominis right", group: "abdominal_muscles" }),
  Object.freeze({ id: 4, slug: "rectus_abdominis_left", name: "Rectus abdominis left", group: "abdominal_muscles" }),
  Object.freeze({ id: 5, slug: "serratus_anterior_right", name: "Serratus anterior right", group: "abdominal_muscles" }),
  Object.freeze({ id: 6, slug: "serratus_anterior_left", name: "Serratus anterior left", group: "abdominal_muscles" }),
  Object.freeze({ id: 7, slug: "latissimus_dorsi_right", name: "Latissimus dorsi right", group: "abdominal_muscles" }),
  Object.freeze({ id: 8, slug: "latissimus_dorsi_left", name: "Latissimus dorsi left", group: "abdominal_muscles" }),
  Object.freeze({ id: 9, slug: "trapezius_right", name: "Trapezius right", group: "abdominal_muscles" }),
  Object.freeze({ id: 10, slug: "trapezius_left", name: "Trapezius left", group: "abdominal_muscles" }),
  Object.freeze({ id: 11, slug: "external_oblique_right", name: "External oblique right", group: "abdominal_muscles" }),
  Object.freeze({ id: 12, slug: "external_oblique_left", name: "External oblique left", group: "abdominal_muscles" }),
  Object.freeze({ id: 13, slug: "internal_oblique_right", name: "Internal oblique right", group: "abdominal_muscles" }),
  Object.freeze({ id: 14, slug: "internal_oblique_left", name: "Internal oblique left", group: "abdominal_muscles" }),
  Object.freeze({ id: 15, slug: "erector_spinae_right", name: "Erector spinae right", group: "abdominal_muscles" }),
  Object.freeze({ id: 16, slug: "erector_spinae_left", name: "Erector spinae left", group: "abdominal_muscles" }),
  Object.freeze({ id: 17, slug: "transversospinalis_right", name: "Transversospinalis right", group: "abdominal_muscles" }),
  Object.freeze({ id: 18, slug: "transversospinalis_left", name: "Transversospinalis left", group: "abdominal_muscles" }),
  Object.freeze({ id: 19, slug: "psoas_major_right", name: "Psoas major right", group: "abdominal_muscles" }),
  Object.freeze({ id: 20, slug: "psoas_major_left", name: "Psoas major left", group: "abdominal_muscles" }),
  Object.freeze({ id: 21, slug: "quadratus_lumborum_right", name: "Quadratus lumborum right", group: "abdominal_muscles" }),
  Object.freeze({ id: 22, slug: "quadratus_lumborum_left", name: "Quadratus lumborum left", group: "abdominal_muscles" }),
]);

export const BODY_LABELS = Object.freeze([
  Object.freeze({ id: 1, slug: "body_trunc", name: "Body trunc", group: "body" }),
  Object.freeze({ id: 2, slug: "body_extremities", name: "Body extremities", group: "body" }),
]);

export const TASK_LABELS = Object.freeze({
  total: TOTAL_CT_LABELS,
  total_mr: TOTAL_MR_LABELS,
  vertebrae_mr: VERTEBRAE_MR_LABELS,
  abdominal_muscles: ABDOMINAL_MUSCLES_LABELS,
  body: BODY_LABELS,
});

export const CT_PART_LUTS = Object.freeze({
  organs: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
  vertebrae: Object.freeze([0, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]),
  cardiac: Object.freeze([0, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68]),
  muscles: Object.freeze([0, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91]),
  ribs: Object.freeze([0, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117]),
});

export const MR_PART_LUTS = Object.freeze({
  organs: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]),
  muscles: Object.freeze([0, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]),
});

export function labelsForTask(task) {
  const list = TASK_LABELS[task];
  if (!list) throw new Error(`Unknown TotalSegmentator task: ${task}`);
  return list;
}

// Distinct, readable RGB colors grouped by anatomical system so bones, muscles,
// vessels and organs are visually separated in NiiVue.
const GROUP_PALETTE = Object.freeze({
  organs: Object.freeze([[231, 111, 81], [244, 162, 97], [233, 196, 106], [42, 157, 143], [38, 128, 158], [168, 85, 247]]),
  vertebrae: Object.freeze([[96, 165, 250], [56, 189, 248], [129, 140, 248], [147, 197, 253]]),
  cardiac: Object.freeze([[239, 68, 68], [244, 63, 94], [251, 113, 133], [220, 38, 38], [249, 115, 22]]),
  muscles: Object.freeze([[52, 211, 153], [16, 185, 129], [163, 230, 53], [132, 204, 22], [34, 197, 94]]),
  ribs: Object.freeze([[250, 204, 21], [251, 191, 36], [245, 158, 11], [253, 224, 71]]),
  abdominal_muscles: Object.freeze([[52, 211, 153], [16, 185, 129], [245, 158, 11], [96, 165, 250], [244, 114, 182], [167, 139, 250]]),
  body: Object.freeze([[56, 189, 248], [168, 85, 247]]),
});

export function colorForLabel(entry, index = entry.id) {
  const palette = GROUP_PALETTE[entry.group] ?? GROUP_PALETTE.organs;
  const base = palette[index % palette.length];
  // Slight deterministic brightness modulation for adjacent structures in the same group.
  const shift = ((index * 37) % 3 - 1) * 18;
  return base.map((channel) => Math.max(24, Math.min(245, channel + shift)));
}

export function colormapForTask(task) {
  const entries = labelsForTask(task);
  const maxId = entries.reduce((m, e) => Math.max(m, e.id), 0);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const R = [0];
  const G = [0];
  const B = [0];
  const A = [0];
  const labels = ['Background'];
  const groupSeen = {};
  for (let id = 1; id <= maxId; id++) {
    const entry = byId.get(id);
    if (!entry) {
      R.push(128);
      G.push(128);
      B.push(128);
      A.push(255);
      labels.push(`Label ${id}`);
      continue;
    }
    const idx = groupSeen[entry.group] ?? 0;
    groupSeen[entry.group] = idx + 1;
    const [r, g, b] = colorForLabel(entry, idx);
    R.push(r);
    G.push(g);
    B.push(b);
    A.push(255);
    labels.push(entry.name);
  }
  return { R, G, B, A, labels };
}
