export const APP_VERSION = "1.4.20260923";
export const TARGET_APP_VERSION = "1.4.20260923";
export const MODEL_BASE_URL = "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap";
export const UPSTREAM_REVISION = "6e1e1eb6732337c13cab53bd5cc800c69024774f";
export const MODEL_RELEASES = [
  {
    "id": "wholebody",
    "name": "musclemap-wholebody.onnx",
    "filename": "musclemap-wholebody.onnx",
    "label": "Whole Body",
    "modelVersion": "1.3",
    "labelSpaceId": "musclemap-wholebody-v1.3",
    "status": "legacy",
    "legacy": true,
    "numClasses": 100,
    "roiSize": [
      256,
      256
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 100,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 1,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.5,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "19976940",
      "doi": "10.5281/zenodo.19976940",
      "configSha256": "221e04d10c68d01dcd316bc852603717fb2e8284a7b079ee76b016e90a2e4561",
      "checkpointSha256": "afa167a749a222601e2024535bca73fb27b34738d58fec5795ed86fa4458c60f",
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "a8cdbf8c2874e1a2f617ecc6695244a0810eac11",
      "url": "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap/musclemap-wholebody.onnx",
      "bytes": 26888722,
      "sha256": "3bff6e22e54d3d7399247d5e71d6423c91bb636d86ab21e0dd929524afbc2bc7",
      "precision": "q8",
      "validationReport": "legacy-provenance-not-recorded",
      "parts": null
    },
    "labelSpace": {
      "id": "musclemap-wholebody-v1.3",
      "modelVersion": "1.3",
      "classCount": 100,
      "externalEncoding": "uint16",
      "maxExternalValue": 8162,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1101,
          "region": "neck",
          "anatomy": "levator scapulae",
          "side": "left",
          "name": "Levator Scapulae L",
          "color": null
        },
        {
          "index": 2,
          "value": 1102,
          "region": "neck",
          "anatomy": "levator scapulae",
          "side": "right",
          "name": "Levator Scapulae R",
          "color": null
        },
        {
          "index": 3,
          "value": 1111,
          "region": "neck",
          "anatomy": "semispinalis cervicis and multifidus",
          "side": "left",
          "name": "Semispinalis Cervicis And Multifidus L",
          "color": null
        },
        {
          "index": 4,
          "value": 1112,
          "region": "neck",
          "anatomy": "semispinalis cervicis and multifidus",
          "side": "right",
          "name": "Semispinalis Cervicis And Multifidus R",
          "color": null
        },
        {
          "index": 5,
          "value": 1121,
          "region": "neck",
          "anatomy": "semispinalis capitis",
          "side": "left",
          "name": "Semispinalis Capitis L",
          "color": null
        },
        {
          "index": 6,
          "value": 1122,
          "region": "neck",
          "anatomy": "semispinalis capitis",
          "side": "right",
          "name": "Semispinalis Capitis R",
          "color": null
        },
        {
          "index": 7,
          "value": 1131,
          "region": "neck",
          "anatomy": "splenius capitis",
          "side": "left",
          "name": "Splenius Capitis L",
          "color": null
        },
        {
          "index": 8,
          "value": 1132,
          "region": "neck",
          "anatomy": "splenius capitis",
          "side": "right",
          "name": "Splenius Capitis R",
          "color": null
        },
        {
          "index": 9,
          "value": 1141,
          "region": "neck",
          "anatomy": "sternocleidomastoid",
          "side": "left",
          "name": "Sternocleidomastoid L",
          "color": null
        },
        {
          "index": 10,
          "value": 1142,
          "region": "neck",
          "anatomy": "sternocleidomastoid",
          "side": "right",
          "name": "Sternocleidomastoid R",
          "color": null
        },
        {
          "index": 11,
          "value": 1151,
          "region": "neck",
          "anatomy": "longus colli",
          "side": "left",
          "name": "Longus Colli L",
          "color": null
        },
        {
          "index": 12,
          "value": 1152,
          "region": "neck",
          "anatomy": "longus colli",
          "side": "right",
          "name": "Longus Colli R",
          "color": null
        },
        {
          "index": 13,
          "value": 1161,
          "region": "neck",
          "anatomy": "trapezius",
          "side": "left",
          "name": "Trapezius L",
          "color": null
        },
        {
          "index": 14,
          "value": 1162,
          "region": "neck",
          "anatomy": "trapezius",
          "side": "right",
          "name": "Trapezius R",
          "color": null
        },
        {
          "index": 15,
          "value": 2101,
          "region": "shoulder",
          "anatomy": "supraspinatus",
          "side": "left",
          "name": "Supraspinatus L",
          "color": null
        },
        {
          "index": 16,
          "value": 2102,
          "region": "shoulder",
          "anatomy": "supraspinatus",
          "side": "right",
          "name": "Supraspinatus R",
          "color": null
        },
        {
          "index": 17,
          "value": 2111,
          "region": "shoulder",
          "anatomy": "subscapularis",
          "side": "left",
          "name": "Subscapularis L",
          "color": null
        },
        {
          "index": 18,
          "value": 2112,
          "region": "shoulder",
          "anatomy": "subscapularis",
          "side": "right",
          "name": "Subscapularis R",
          "color": null
        },
        {
          "index": 19,
          "value": 2121,
          "region": "shoulder",
          "anatomy": "infraspinatus",
          "side": "left",
          "name": "Infraspinatus L",
          "color": null
        },
        {
          "index": 20,
          "value": 2122,
          "region": "shoulder",
          "anatomy": "infraspinatus",
          "side": "right",
          "name": "Infraspinatus R",
          "color": null
        },
        {
          "index": 21,
          "value": 2141,
          "region": "shoulder",
          "anatomy": "deltoid",
          "side": "left",
          "name": "Deltoid L",
          "color": null
        },
        {
          "index": 22,
          "value": 2142,
          "region": "shoulder",
          "anatomy": "deltoid",
          "side": "right",
          "name": "Deltoid R",
          "color": null
        },
        {
          "index": 23,
          "value": 4101,
          "region": "thorax",
          "anatomy": "rhomboid",
          "side": "left",
          "name": "Rhomboid L",
          "color": null
        },
        {
          "index": 24,
          "value": 4102,
          "region": "thorax",
          "anatomy": "rhomboid",
          "side": "right",
          "name": "Rhomboid R",
          "color": null
        },
        {
          "index": 25,
          "value": 5101,
          "region": "abdomen",
          "anatomy": "thoracolumbar multifidus",
          "side": "left",
          "name": "Thoracolumbar Multifidus L",
          "color": null
        },
        {
          "index": 26,
          "value": 5102,
          "region": "abdomen",
          "anatomy": "thoracolumbar multifidus",
          "side": "right",
          "name": "Thoracolumbar Multifidus R",
          "color": null
        },
        {
          "index": 27,
          "value": 5111,
          "region": "abdomen",
          "anatomy": "erector spinae",
          "side": "left",
          "name": "Erector Spinae L",
          "color": null
        },
        {
          "index": 28,
          "value": 5112,
          "region": "abdomen",
          "anatomy": "erector spinae",
          "side": "right",
          "name": "Erector Spinae R",
          "color": null
        },
        {
          "index": 29,
          "value": 5121,
          "region": "abdomen",
          "anatomy": "psoas major",
          "side": "left",
          "name": "Psoas Major L",
          "color": null
        },
        {
          "index": 30,
          "value": 5122,
          "region": "abdomen",
          "anatomy": "psoas major",
          "side": "right",
          "name": "Psoas Major R",
          "color": null
        },
        {
          "index": 31,
          "value": 5131,
          "region": "abdomen",
          "anatomy": "quadratus lumborum",
          "side": "left",
          "name": "Quadratus Lumborum L",
          "color": null
        },
        {
          "index": 32,
          "value": 5132,
          "region": "abdomen",
          "anatomy": "quadratus lumborum",
          "side": "right",
          "name": "Quadratus Lumborum R",
          "color": null
        },
        {
          "index": 33,
          "value": 5141,
          "region": "abdomen",
          "anatomy": "lattisimus dorsi",
          "side": "left",
          "name": "Lattisimus Dorsi L",
          "color": null
        },
        {
          "index": 34,
          "value": 5142,
          "region": "abdomen",
          "anatomy": "lattisimus dorsi",
          "side": "right",
          "name": "Lattisimus Dorsi R",
          "color": null
        },
        {
          "index": 35,
          "value": 6101,
          "region": "pelvis",
          "anatomy": "gluteus minimus",
          "side": "left",
          "name": "Gluteus Minimus L",
          "color": null
        },
        {
          "index": 36,
          "value": 6102,
          "region": "pelvis",
          "anatomy": "gluteus minimus",
          "side": "right",
          "name": "Gluteus Minimus R",
          "color": null
        },
        {
          "index": 37,
          "value": 6111,
          "region": "pelvis",
          "anatomy": "gluteus medius",
          "side": "left",
          "name": "Gluteus Medius L",
          "color": null
        },
        {
          "index": 38,
          "value": 6112,
          "region": "pelvis",
          "anatomy": "gluteus medius",
          "side": "right",
          "name": "Gluteus Medius R",
          "color": null
        },
        {
          "index": 39,
          "value": 6121,
          "region": "pelvis",
          "anatomy": "gluteus maximus",
          "side": "left",
          "name": "Gluteus Maximus L",
          "color": null
        },
        {
          "index": 40,
          "value": 6122,
          "region": "pelvis",
          "anatomy": "gluteus maximus",
          "side": "right",
          "name": "Gluteus Maximus R",
          "color": null
        },
        {
          "index": 41,
          "value": 6131,
          "region": "pelvis",
          "anatomy": "tensor fascia latae",
          "side": "left",
          "name": "Tensor Fascia Latae L",
          "color": null
        },
        {
          "index": 42,
          "value": 6132,
          "region": "pelvis",
          "anatomy": "tensor fascia latae",
          "side": "right",
          "name": "Tensor Fascia Latae R",
          "color": null
        },
        {
          "index": 43,
          "value": 6141,
          "region": "pelvis",
          "anatomy": "iliacus",
          "side": "left",
          "name": "Iliacus L",
          "color": null
        },
        {
          "index": 44,
          "value": 6142,
          "region": "pelvis",
          "anatomy": "iliacus",
          "side": "right",
          "name": "Iliacus R",
          "color": null
        },
        {
          "index": 45,
          "value": 6151,
          "region": "pelvis",
          "anatomy": "ilium",
          "side": "left",
          "name": "Ilium L",
          "color": null
        },
        {
          "index": 46,
          "value": 6152,
          "region": "pelvis",
          "anatomy": "ilium",
          "side": "right",
          "name": "Ilium R",
          "color": null
        },
        {
          "index": 47,
          "value": 6160,
          "region": "pelvis",
          "anatomy": "sacrum",
          "side": "no side",
          "name": "Sacrum",
          "color": null
        },
        {
          "index": 48,
          "value": 6171,
          "region": "pelvis",
          "anatomy": "femur",
          "side": "left",
          "name": "Femur L",
          "color": null
        },
        {
          "index": 49,
          "value": 6172,
          "region": "pelvis",
          "anatomy": "femur",
          "side": "right",
          "name": "Femur R",
          "color": null
        },
        {
          "index": 50,
          "value": 6181,
          "region": "pelvis",
          "anatomy": "piriformis",
          "side": "left",
          "name": "Piriformis L",
          "color": null
        },
        {
          "index": 51,
          "value": 6182,
          "region": "pelvis",
          "anatomy": "piriformis",
          "side": "right",
          "name": "Piriformis R",
          "color": null
        },
        {
          "index": 52,
          "value": 6191,
          "region": "pelvis",
          "anatomy": "pectineus",
          "side": "left",
          "name": "Pectineus L",
          "color": null
        },
        {
          "index": 53,
          "value": 6192,
          "region": "pelvis",
          "anatomy": "pectineus",
          "side": "right",
          "name": "Pectineus R",
          "color": null
        },
        {
          "index": 54,
          "value": 6201,
          "region": "pelvis",
          "anatomy": "obturator internus",
          "side": "left",
          "name": "Obturator Internus L",
          "color": null
        },
        {
          "index": 55,
          "value": 6202,
          "region": "pelvis",
          "anatomy": "obturator internus",
          "side": "right",
          "name": "Obturator Internus R",
          "color": null
        },
        {
          "index": 56,
          "value": 6211,
          "region": "pelvis",
          "anatomy": "obturator externus",
          "side": "left",
          "name": "Obturator Externus L",
          "color": null
        },
        {
          "index": 57,
          "value": 6212,
          "region": "pelvis",
          "anatomy": "obturator externus",
          "side": "right",
          "name": "Obturator Externus R",
          "color": null
        },
        {
          "index": 58,
          "value": 6221,
          "region": "pelvis",
          "anatomy": "gemelli and quadratus femoris",
          "side": "left",
          "name": "Gemelli And Quadratus Femoris L",
          "color": null
        },
        {
          "index": 59,
          "value": 6222,
          "region": "pelvis",
          "anatomy": "gemelli and quadratus femoris",
          "side": "right",
          "name": "Gemelli And Quadratus Femoris R",
          "color": null
        },
        {
          "index": 60,
          "value": 7101,
          "region": "thigh",
          "anatomy": "vastus lateralis",
          "side": "left",
          "name": "Vastus Lateralis L",
          "color": null
        },
        {
          "index": 61,
          "value": 7102,
          "region": "thigh",
          "anatomy": "vastus lateralis",
          "side": "right",
          "name": "Vastus Lateralis R",
          "color": null
        },
        {
          "index": 62,
          "value": 7111,
          "region": "thigh",
          "anatomy": "vastus intermedius",
          "side": "left",
          "name": "Vastus Intermedius L",
          "color": null
        },
        {
          "index": 63,
          "value": 7112,
          "region": "thigh",
          "anatomy": "vastus intermedius",
          "side": "right",
          "name": "Vastus Intermedius R",
          "color": null
        },
        {
          "index": 64,
          "value": 7121,
          "region": "thigh",
          "anatomy": "vastus medialis",
          "side": "left",
          "name": "Vastus Medialis L",
          "color": null
        },
        {
          "index": 65,
          "value": 7122,
          "region": "thigh",
          "anatomy": "vastus medialis",
          "side": "right",
          "name": "Vastus Medialis R",
          "color": null
        },
        {
          "index": 66,
          "value": 7131,
          "region": "thigh",
          "anatomy": "rectus femoris",
          "side": "left",
          "name": "Rectus Femoris L",
          "color": null
        },
        {
          "index": 67,
          "value": 7132,
          "region": "thigh",
          "anatomy": "rectus femoris",
          "side": "right",
          "name": "Rectus Femoris R",
          "color": null
        },
        {
          "index": 68,
          "value": 7141,
          "region": "thigh",
          "anatomy": "sartorius",
          "side": "left",
          "name": "Sartorius L",
          "color": null
        },
        {
          "index": 69,
          "value": 7142,
          "region": "thigh",
          "anatomy": "sartorius",
          "side": "right",
          "name": "Sartorius R",
          "color": null
        },
        {
          "index": 70,
          "value": 7151,
          "region": "thigh",
          "anatomy": "gracilis",
          "side": "left",
          "name": "Gracilis L",
          "color": null
        },
        {
          "index": 71,
          "value": 7152,
          "region": "thigh",
          "anatomy": "gracilis",
          "side": "right",
          "name": "Gracilis R",
          "color": null
        },
        {
          "index": 72,
          "value": 7161,
          "region": "thigh",
          "anatomy": "semimembranosus",
          "side": "left",
          "name": "Semimembranosus L",
          "color": null
        },
        {
          "index": 73,
          "value": 7162,
          "region": "thigh",
          "anatomy": "semimembranosus",
          "side": "right",
          "name": "Semimembranosus R",
          "color": null
        },
        {
          "index": 74,
          "value": 7171,
          "region": "thigh",
          "anatomy": "semitendinosus",
          "side": "left",
          "name": "Semitendinosus L",
          "color": null
        },
        {
          "index": 75,
          "value": 7172,
          "region": "thigh",
          "anatomy": "semitendinosus",
          "side": "right",
          "name": "Semitendinosus R",
          "color": null
        },
        {
          "index": 76,
          "value": 7181,
          "region": "thigh",
          "anatomy": "biceps femoris long head",
          "side": "left",
          "name": "Biceps Femoris Long Head L",
          "color": null
        },
        {
          "index": 77,
          "value": 7182,
          "region": "thigh",
          "anatomy": "biceps femoris long head",
          "side": "right",
          "name": "Biceps Femoris Long Head R",
          "color": null
        },
        {
          "index": 78,
          "value": 7191,
          "region": "thigh",
          "anatomy": "biceps femoris short head",
          "side": "left",
          "name": "Biceps Femoris Short Head L",
          "color": null
        },
        {
          "index": 79,
          "value": 7192,
          "region": "thigh",
          "anatomy": "biceps femoris short head",
          "side": "right",
          "name": "Biceps Femoris Short Head R",
          "color": null
        },
        {
          "index": 80,
          "value": 7201,
          "region": "thigh",
          "anatomy": "adductor magnus",
          "side": "left",
          "name": "Adductor Magnus L",
          "color": null
        },
        {
          "index": 81,
          "value": 7202,
          "region": "thigh",
          "anatomy": "adductor magnus",
          "side": "right",
          "name": "Adductor Magnus R",
          "color": null
        },
        {
          "index": 82,
          "value": 7211,
          "region": "thigh",
          "anatomy": "adductor longus",
          "side": "left",
          "name": "Adductor Longus L",
          "color": null
        },
        {
          "index": 83,
          "value": 7212,
          "region": "thigh",
          "anatomy": "adductor longus",
          "side": "right",
          "name": "Adductor Longus R",
          "color": null
        },
        {
          "index": 84,
          "value": 7221,
          "region": "thigh",
          "anatomy": "adductor brevis",
          "side": "left",
          "name": "Adductor Brevis L",
          "color": null
        },
        {
          "index": 85,
          "value": 7222,
          "region": "thigh",
          "anatomy": "adductor brevis",
          "side": "right",
          "name": "Adductor Brevis R",
          "color": null
        },
        {
          "index": 86,
          "value": 8101,
          "region": "leg",
          "anatomy": "anterior compartment",
          "side": "left",
          "name": "Anterior Compartment L",
          "color": null
        },
        {
          "index": 87,
          "value": 8102,
          "region": "leg",
          "anatomy": "anterior compartment",
          "side": "right",
          "name": "Anterior Compartment R",
          "color": null
        },
        {
          "index": 88,
          "value": 8111,
          "region": "leg",
          "anatomy": "deep posterior compartment",
          "side": "left",
          "name": "Deep Posterior Compartment L",
          "color": null
        },
        {
          "index": 89,
          "value": 8112,
          "region": "leg",
          "anatomy": "deep posterior compartment",
          "side": "right",
          "name": "Deep Posterior Compartment R",
          "color": null
        },
        {
          "index": 90,
          "value": 8121,
          "region": "leg",
          "anatomy": "lateral compartment",
          "side": "left",
          "name": "Lateral Compartment L",
          "color": null
        },
        {
          "index": 91,
          "value": 8122,
          "region": "leg",
          "anatomy": "lateral compartment",
          "side": "right",
          "name": "Lateral Compartment R",
          "color": null
        },
        {
          "index": 92,
          "value": 8131,
          "region": "leg",
          "anatomy": "soleus",
          "side": "left",
          "name": "Soleus L",
          "color": null
        },
        {
          "index": 93,
          "value": 8132,
          "region": "leg",
          "anatomy": "soleus",
          "side": "right",
          "name": "Soleus R",
          "color": null
        },
        {
          "index": 94,
          "value": 8141,
          "region": "leg",
          "anatomy": "gastrocnemius",
          "side": "left",
          "name": "Gastrocnemius L",
          "color": null
        },
        {
          "index": 95,
          "value": 8142,
          "region": "leg",
          "anatomy": "gastrocnemius",
          "side": "right",
          "name": "Gastrocnemius R",
          "color": null
        },
        {
          "index": 96,
          "value": 8151,
          "region": "leg",
          "anatomy": "tibia",
          "side": "left",
          "name": "Tibia L",
          "color": null
        },
        {
          "index": 97,
          "value": 8152,
          "region": "leg",
          "anatomy": "tibia",
          "side": "right",
          "name": "Tibia R",
          "color": null
        },
        {
          "index": 98,
          "value": 8161,
          "region": "leg",
          "anatomy": "fibula",
          "side": "left",
          "name": "Fibula L",
          "color": null
        },
        {
          "index": 99,
          "value": 8162,
          "region": "leg",
          "anatomy": "fibula",
          "side": "right",
          "name": "Fibula R",
          "color": null
        }
      ]
    }
  },
  {
    "id": "wholebody",
    "name": "musclemap-wholebody.onnx",
    "filename": "musclemap-wholebody.onnx",
    "label": "Whole Body",
    "modelVersion": "1.4",
    "labelSpaceId": "musclemap-wholebody-v1.4",
    "status": "active",
    "legacy": false,
    "numClasses": 114,
    "roiSize": [
      256,
      256
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 114,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 2,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.9,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "21929873",
      "doi": "10.5281/zenodo.21929873",
      "configSha256": "82c74f854ab74d8770e6e2b9a240bd23ccc646a7b71b13e6cfd8f9919d2acb26",
      "checkpointSha256": "45dfa2843d2e0b1fd842152d6a79bfd4bcb90899c076ceb6346c59da9a79a16c",
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "6380bd2487eeb47bdc59d63eef69fb0241bd1197",
      "url": "https://github.com/neurodesk/webapps/releases/download/musclemap-model-v1.4-fp32/musclemap-wholebody-v1.4-fp32.onnx",
      "bytes": 104946960,
      "sha256": "6380bd2487eeb47bdc59d63eef69fb0241bd11976712677ccee329f83552a1e6",
      "precision": "fp32",
      "validationReport": "https://github.com/neurodesk/webapps/releases/download/musclemap-model-v1.4-fp32/musclemap-v1.4-conversion-evidence.json",
      "parts": [
        {
          "path": "models/musclemap-wholebody-v1.4-fp32.part-00",
          "bytes": 21000000,
          "sha256": "15a325c63285f00661dfabb58e924958ac9fd33b76868e0431988567c4b49781"
        },
        {
          "path": "models/musclemap-wholebody-v1.4-fp32.part-01",
          "bytes": 21000000,
          "sha256": "1428e9754815bf1bf0fe269578e44788be5f6cffa3f110d880f7d05ca918db6a"
        },
        {
          "path": "models/musclemap-wholebody-v1.4-fp32.part-02",
          "bytes": 21000000,
          "sha256": "4846fac49ecb36749b1ad937752d3ccf46c3a7ea48f4ebca4a1b4c71071b3e48"
        },
        {
          "path": "models/musclemap-wholebody-v1.4-fp32.part-03",
          "bytes": 21000000,
          "sha256": "63246bd7ae1711fc560ae368a5ec07a168c6ca18c32ce1c62aa1193483fd9feb"
        },
        {
          "path": "models/musclemap-wholebody-v1.4-fp32.part-04",
          "bytes": 20946960,
          "sha256": "899040852445f7082e4198aafabb20380ed9f2b54e77533500a64ed39b04906d"
        }
      ]
    },
    "labelSpace": {
      "id": "musclemap-wholebody-v1.4",
      "modelVersion": "1.4",
      "classCount": 114,
      "externalEncoding": "uint16",
      "maxExternalValue": 8222,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1101,
          "region": "neck",
          "anatomy": "levator scapulae",
          "side": "left",
          "name": "Levator Scapulae L",
          "color": null
        },
        {
          "index": 2,
          "value": 1102,
          "region": "neck",
          "anatomy": "levator scapulae",
          "side": "right",
          "name": "Levator Scapulae R",
          "color": null
        },
        {
          "index": 3,
          "value": 1111,
          "region": "neck",
          "anatomy": "semispinalis cervicis and multifidus",
          "side": "left",
          "name": "Semispinalis Cervicis And Multifidus L",
          "color": null
        },
        {
          "index": 4,
          "value": 1112,
          "region": "neck",
          "anatomy": "semispinalis cervicis and multifidus",
          "side": "right",
          "name": "Semispinalis Cervicis And Multifidus R",
          "color": null
        },
        {
          "index": 5,
          "value": 1121,
          "region": "neck",
          "anatomy": "semispinalis capitis",
          "side": "left",
          "name": "Semispinalis Capitis L",
          "color": null
        },
        {
          "index": 6,
          "value": 1122,
          "region": "neck",
          "anatomy": "semispinalis capitis",
          "side": "right",
          "name": "Semispinalis Capitis R",
          "color": null
        },
        {
          "index": 7,
          "value": 1131,
          "region": "neck",
          "anatomy": "splenius capitis",
          "side": "left",
          "name": "Splenius Capitis L",
          "color": null
        },
        {
          "index": 8,
          "value": 1132,
          "region": "neck",
          "anatomy": "splenius capitis",
          "side": "right",
          "name": "Splenius Capitis R",
          "color": null
        },
        {
          "index": 9,
          "value": 1141,
          "region": "neck",
          "anatomy": "sternocleidomastoid",
          "side": "left",
          "name": "Sternocleidomastoid L",
          "color": null
        },
        {
          "index": 10,
          "value": 1142,
          "region": "neck",
          "anatomy": "sternocleidomastoid",
          "side": "right",
          "name": "Sternocleidomastoid R",
          "color": null
        },
        {
          "index": 11,
          "value": 1151,
          "region": "neck",
          "anatomy": "longus colli",
          "side": "left",
          "name": "Longus Colli L",
          "color": null
        },
        {
          "index": 12,
          "value": 1152,
          "region": "neck",
          "anatomy": "longus colli",
          "side": "right",
          "name": "Longus Colli R",
          "color": null
        },
        {
          "index": 13,
          "value": 1161,
          "region": "neck",
          "anatomy": "trapezius",
          "side": "left",
          "name": "Trapezius L",
          "color": null
        },
        {
          "index": 14,
          "value": 1162,
          "region": "neck",
          "anatomy": "trapezius",
          "side": "right",
          "name": "Trapezius R",
          "color": null
        },
        {
          "index": 15,
          "value": 2101,
          "region": "shoulder",
          "anatomy": "supraspinatus",
          "side": "left",
          "name": "Supraspinatus L",
          "color": null
        },
        {
          "index": 16,
          "value": 2102,
          "region": "shoulder",
          "anatomy": "supraspinatus",
          "side": "right",
          "name": "Supraspinatus R",
          "color": null
        },
        {
          "index": 17,
          "value": 2111,
          "region": "shoulder",
          "anatomy": "subscapularis",
          "side": "left",
          "name": "Subscapularis L",
          "color": null
        },
        {
          "index": 18,
          "value": 2112,
          "region": "shoulder",
          "anatomy": "subscapularis",
          "side": "right",
          "name": "Subscapularis R",
          "color": null
        },
        {
          "index": 19,
          "value": 2121,
          "region": "shoulder",
          "anatomy": "infraspinatus",
          "side": "left",
          "name": "Infraspinatus L",
          "color": null
        },
        {
          "index": 20,
          "value": 2122,
          "region": "shoulder",
          "anatomy": "infraspinatus",
          "side": "right",
          "name": "Infraspinatus R",
          "color": null
        },
        {
          "index": 21,
          "value": 2141,
          "region": "shoulder",
          "anatomy": "deltoid",
          "side": "left",
          "name": "Deltoid L",
          "color": null
        },
        {
          "index": 22,
          "value": 2142,
          "region": "shoulder",
          "anatomy": "deltoid",
          "side": "right",
          "name": "Deltoid R",
          "color": null
        },
        {
          "index": 23,
          "value": 4101,
          "region": "thorax",
          "anatomy": "rhomboid",
          "side": "left",
          "name": "Rhomboid L",
          "color": null
        },
        {
          "index": 24,
          "value": 4102,
          "region": "thorax",
          "anatomy": "rhomboid",
          "side": "right",
          "name": "Rhomboid R",
          "color": null
        },
        {
          "index": 25,
          "value": 5101,
          "region": "abdomen",
          "anatomy": "thoracolumbar multifidus",
          "side": "left",
          "name": "Thoracolumbar Multifidus L",
          "color": null
        },
        {
          "index": 26,
          "value": 5102,
          "region": "abdomen",
          "anatomy": "thoracolumbar multifidus",
          "side": "right",
          "name": "Thoracolumbar Multifidus R",
          "color": null
        },
        {
          "index": 27,
          "value": 5111,
          "region": "abdomen",
          "anatomy": "erector spinae",
          "side": "left",
          "name": "Erector Spinae L",
          "color": null
        },
        {
          "index": 28,
          "value": 5112,
          "region": "abdomen",
          "anatomy": "erector spinae",
          "side": "right",
          "name": "Erector Spinae R",
          "color": null
        },
        {
          "index": 29,
          "value": 5121,
          "region": "abdomen",
          "anatomy": "psoas major",
          "side": "left",
          "name": "Psoas Major L",
          "color": null
        },
        {
          "index": 30,
          "value": 5122,
          "region": "abdomen",
          "anatomy": "psoas major",
          "side": "right",
          "name": "Psoas Major R",
          "color": null
        },
        {
          "index": 31,
          "value": 5131,
          "region": "abdomen",
          "anatomy": "quadratus lumborum",
          "side": "left",
          "name": "Quadratus Lumborum L",
          "color": null
        },
        {
          "index": 32,
          "value": 5132,
          "region": "abdomen",
          "anatomy": "quadratus lumborum",
          "side": "right",
          "name": "Quadratus Lumborum R",
          "color": null
        },
        {
          "index": 33,
          "value": 5141,
          "region": "abdomen",
          "anatomy": "latissimus dorsi",
          "side": "left",
          "name": "Latissimus Dorsi L",
          "color": null
        },
        {
          "index": 34,
          "value": 5142,
          "region": "abdomen",
          "anatomy": "latissimus dorsi",
          "side": "right",
          "name": "Latissimus Dorsi R",
          "color": null
        },
        {
          "index": 35,
          "value": 6101,
          "region": "pelvis",
          "anatomy": "gluteus minimus",
          "side": "left",
          "name": "Gluteus Minimus L",
          "color": null
        },
        {
          "index": 36,
          "value": 6102,
          "region": "pelvis",
          "anatomy": "gluteus minimus",
          "side": "right",
          "name": "Gluteus Minimus R",
          "color": null
        },
        {
          "index": 37,
          "value": 6111,
          "region": "pelvis",
          "anatomy": "gluteus medius",
          "side": "left",
          "name": "Gluteus Medius L",
          "color": null
        },
        {
          "index": 38,
          "value": 6112,
          "region": "pelvis",
          "anatomy": "gluteus medius",
          "side": "right",
          "name": "Gluteus Medius R",
          "color": null
        },
        {
          "index": 39,
          "value": 6121,
          "region": "pelvis",
          "anatomy": "gluteus maximus",
          "side": "left",
          "name": "Gluteus Maximus L",
          "color": null
        },
        {
          "index": 40,
          "value": 6122,
          "region": "pelvis",
          "anatomy": "gluteus maximus",
          "side": "right",
          "name": "Gluteus Maximus R",
          "color": null
        },
        {
          "index": 41,
          "value": 6131,
          "region": "pelvis",
          "anatomy": "tensor fasciae latae",
          "side": "left",
          "name": "Tensor Fasciae Latae L",
          "color": null
        },
        {
          "index": 42,
          "value": 6132,
          "region": "pelvis",
          "anatomy": "tensor fasciae latae",
          "side": "right",
          "name": "Tensor Fasciae Latae R",
          "color": null
        },
        {
          "index": 43,
          "value": 6141,
          "region": "pelvis",
          "anatomy": "iliacus",
          "side": "left",
          "name": "Iliacus L",
          "color": null
        },
        {
          "index": 44,
          "value": 6142,
          "region": "pelvis",
          "anatomy": "iliacus",
          "side": "right",
          "name": "Iliacus R",
          "color": null
        },
        {
          "index": 45,
          "value": 6151,
          "region": "pelvis",
          "anatomy": "ilium",
          "side": "left",
          "name": "Ilium L",
          "color": null
        },
        {
          "index": 46,
          "value": 6152,
          "region": "pelvis",
          "anatomy": "ilium",
          "side": "right",
          "name": "Ilium R",
          "color": null
        },
        {
          "index": 47,
          "value": 6160,
          "region": "pelvis",
          "anatomy": "sacrum",
          "side": "no side",
          "name": "Sacrum",
          "color": null
        },
        {
          "index": 48,
          "value": 6171,
          "region": "pelvis",
          "anatomy": "femur",
          "side": "left",
          "name": "Femur L",
          "color": null
        },
        {
          "index": 49,
          "value": 6172,
          "region": "pelvis",
          "anatomy": "femur",
          "side": "right",
          "name": "Femur R",
          "color": null
        },
        {
          "index": 50,
          "value": 6181,
          "region": "pelvis",
          "anatomy": "piriformis",
          "side": "left",
          "name": "Piriformis L",
          "color": null
        },
        {
          "index": 51,
          "value": 6182,
          "region": "pelvis",
          "anatomy": "piriformis",
          "side": "right",
          "name": "Piriformis R",
          "color": null
        },
        {
          "index": 52,
          "value": 6191,
          "region": "pelvis",
          "anatomy": "pectineus",
          "side": "left",
          "name": "Pectineus L",
          "color": null
        },
        {
          "index": 53,
          "value": 6192,
          "region": "pelvis",
          "anatomy": "pectineus",
          "side": "right",
          "name": "Pectineus R",
          "color": null
        },
        {
          "index": 54,
          "value": 6201,
          "region": "pelvis",
          "anatomy": "obturator internus",
          "side": "left",
          "name": "Obturator Internus L",
          "color": null
        },
        {
          "index": 55,
          "value": 6202,
          "region": "pelvis",
          "anatomy": "obturator internus",
          "side": "right",
          "name": "Obturator Internus R",
          "color": null
        },
        {
          "index": 56,
          "value": 6211,
          "region": "pelvis",
          "anatomy": "obturator externus",
          "side": "left",
          "name": "Obturator Externus L",
          "color": null
        },
        {
          "index": 57,
          "value": 6212,
          "region": "pelvis",
          "anatomy": "obturator externus",
          "side": "right",
          "name": "Obturator Externus R",
          "color": null
        },
        {
          "index": 58,
          "value": 6221,
          "region": "pelvis",
          "anatomy": "gemelli and quadratus femoris",
          "side": "left",
          "name": "Gemelli And Quadratus Femoris L",
          "color": null
        },
        {
          "index": 59,
          "value": 6222,
          "region": "pelvis",
          "anatomy": "gemelli and quadratus femoris",
          "side": "right",
          "name": "Gemelli And Quadratus Femoris R",
          "color": null
        },
        {
          "index": 60,
          "value": 7101,
          "region": "thigh",
          "anatomy": "vastus lateralis",
          "side": "left",
          "name": "Vastus Lateralis L",
          "color": null
        },
        {
          "index": 61,
          "value": 7102,
          "region": "thigh",
          "anatomy": "vastus lateralis",
          "side": "right",
          "name": "Vastus Lateralis R",
          "color": null
        },
        {
          "index": 62,
          "value": 7111,
          "region": "thigh",
          "anatomy": "vastus intermedius",
          "side": "left",
          "name": "Vastus Intermedius L",
          "color": null
        },
        {
          "index": 63,
          "value": 7112,
          "region": "thigh",
          "anatomy": "vastus intermedius",
          "side": "right",
          "name": "Vastus Intermedius R",
          "color": null
        },
        {
          "index": 64,
          "value": 7121,
          "region": "thigh",
          "anatomy": "vastus medialis",
          "side": "left",
          "name": "Vastus Medialis L",
          "color": null
        },
        {
          "index": 65,
          "value": 7122,
          "region": "thigh",
          "anatomy": "vastus medialis",
          "side": "right",
          "name": "Vastus Medialis R",
          "color": null
        },
        {
          "index": 66,
          "value": 7131,
          "region": "thigh",
          "anatomy": "rectus femoris",
          "side": "left",
          "name": "Rectus Femoris L",
          "color": null
        },
        {
          "index": 67,
          "value": 7132,
          "region": "thigh",
          "anatomy": "rectus femoris",
          "side": "right",
          "name": "Rectus Femoris R",
          "color": null
        },
        {
          "index": 68,
          "value": 7141,
          "region": "thigh",
          "anatomy": "sartorius",
          "side": "left",
          "name": "Sartorius L",
          "color": null
        },
        {
          "index": 69,
          "value": 7142,
          "region": "thigh",
          "anatomy": "sartorius",
          "side": "right",
          "name": "Sartorius R",
          "color": null
        },
        {
          "index": 70,
          "value": 7151,
          "region": "thigh",
          "anatomy": "gracilis",
          "side": "left",
          "name": "Gracilis L",
          "color": null
        },
        {
          "index": 71,
          "value": 7152,
          "region": "thigh",
          "anatomy": "gracilis",
          "side": "right",
          "name": "Gracilis R",
          "color": null
        },
        {
          "index": 72,
          "value": 7161,
          "region": "thigh",
          "anatomy": "semimembranosus",
          "side": "left",
          "name": "Semimembranosus L",
          "color": null
        },
        {
          "index": 73,
          "value": 7162,
          "region": "thigh",
          "anatomy": "semimembranosus",
          "side": "right",
          "name": "Semimembranosus R",
          "color": null
        },
        {
          "index": 74,
          "value": 7171,
          "region": "thigh",
          "anatomy": "semitendinosus",
          "side": "left",
          "name": "Semitendinosus L",
          "color": null
        },
        {
          "index": 75,
          "value": 7172,
          "region": "thigh",
          "anatomy": "semitendinosus",
          "side": "right",
          "name": "Semitendinosus R",
          "color": null
        },
        {
          "index": 76,
          "value": 7181,
          "region": "thigh",
          "anatomy": "biceps femoris long head",
          "side": "left",
          "name": "Biceps Femoris Long Head L",
          "color": null
        },
        {
          "index": 77,
          "value": 7182,
          "region": "thigh",
          "anatomy": "biceps femoris long head",
          "side": "right",
          "name": "Biceps Femoris Long Head R",
          "color": null
        },
        {
          "index": 78,
          "value": 7191,
          "region": "thigh",
          "anatomy": "biceps femoris short head",
          "side": "left",
          "name": "Biceps Femoris Short Head L",
          "color": null
        },
        {
          "index": 79,
          "value": 7192,
          "region": "thigh",
          "anatomy": "biceps femoris short head",
          "side": "right",
          "name": "Biceps Femoris Short Head R",
          "color": null
        },
        {
          "index": 80,
          "value": 7201,
          "region": "thigh",
          "anatomy": "adductor magnus",
          "side": "left",
          "name": "Adductor Magnus L",
          "color": null
        },
        {
          "index": 81,
          "value": 7202,
          "region": "thigh",
          "anatomy": "adductor magnus",
          "side": "right",
          "name": "Adductor Magnus R",
          "color": null
        },
        {
          "index": 82,
          "value": 7211,
          "region": "thigh",
          "anatomy": "adductor longus",
          "side": "left",
          "name": "Adductor Longus L",
          "color": null
        },
        {
          "index": 83,
          "value": 7212,
          "region": "thigh",
          "anatomy": "adductor longus",
          "side": "right",
          "name": "Adductor Longus R",
          "color": null
        },
        {
          "index": 84,
          "value": 7221,
          "region": "thigh",
          "anatomy": "adductor brevis",
          "side": "left",
          "name": "Adductor Brevis L",
          "color": null
        },
        {
          "index": 85,
          "value": 7222,
          "region": "thigh",
          "anatomy": "adductor brevis",
          "side": "right",
          "name": "Adductor Brevis R",
          "color": null
        },
        {
          "index": 86,
          "value": 7231,
          "region": "thigh",
          "anatomy": "patella",
          "side": "left",
          "name": "Patella L",
          "color": null
        },
        {
          "index": 87,
          "value": 7232,
          "region": "thigh",
          "anatomy": "patella",
          "side": "right",
          "name": "Patella R",
          "color": null
        },
        {
          "index": 88,
          "value": 8101,
          "region": "leg",
          "anatomy": "tibialis anterior",
          "side": "left",
          "name": "Tibialis Anterior L",
          "color": null
        },
        {
          "index": 89,
          "value": 8102,
          "region": "leg",
          "anatomy": "tibialis anterior",
          "side": "right",
          "name": "Tibialis Anterior R",
          "color": null
        },
        {
          "index": 90,
          "value": 8111,
          "region": "leg",
          "anatomy": "tibialis posterior",
          "side": "left",
          "name": "Tibialis Posterior L",
          "color": null
        },
        {
          "index": 91,
          "value": 8112,
          "region": "leg",
          "anatomy": "tibialis posterior",
          "side": "right",
          "name": "Tibialis Posterior R",
          "color": null
        },
        {
          "index": 92,
          "value": 8121,
          "region": "leg",
          "anatomy": "peroneus longus",
          "side": "left",
          "name": "Peroneus Longus L",
          "color": null
        },
        {
          "index": 93,
          "value": 8122,
          "region": "leg",
          "anatomy": "peroneus longus",
          "side": "right",
          "name": "Peroneus Longus R",
          "color": null
        },
        {
          "index": 94,
          "value": 8131,
          "region": "leg",
          "anatomy": "soleus",
          "side": "left",
          "name": "Soleus L",
          "color": null
        },
        {
          "index": 95,
          "value": 8132,
          "region": "leg",
          "anatomy": "soleus",
          "side": "right",
          "name": "Soleus R",
          "color": null
        },
        {
          "index": 96,
          "value": 8141,
          "region": "leg",
          "anatomy": "medial gastrocnemius",
          "side": "left",
          "name": "Medial Gastrocnemius L",
          "color": null
        },
        {
          "index": 97,
          "value": 8142,
          "region": "leg",
          "anatomy": "medial gastrocnemius",
          "side": "right",
          "name": "Medial Gastrocnemius R",
          "color": null
        },
        {
          "index": 98,
          "value": 8151,
          "region": "leg",
          "anatomy": "lateral gastrocnemius",
          "side": "left",
          "name": "Lateral Gastrocnemius L",
          "color": null
        },
        {
          "index": 99,
          "value": 8152,
          "region": "leg",
          "anatomy": "lateral gastrocnemius",
          "side": "right",
          "name": "Lateral Gastrocnemius R",
          "color": null
        },
        {
          "index": 100,
          "value": 8161,
          "region": "leg",
          "anatomy": "tibia",
          "side": "left",
          "name": "Tibia L",
          "color": null
        },
        {
          "index": 101,
          "value": 8162,
          "region": "leg",
          "anatomy": "tibia",
          "side": "right",
          "name": "Tibia R",
          "color": null
        },
        {
          "index": 102,
          "value": 8171,
          "region": "leg",
          "anatomy": "fibula",
          "side": "left",
          "name": "Fibula L",
          "color": null
        },
        {
          "index": 103,
          "value": 8172,
          "region": "leg",
          "anatomy": "fibula",
          "side": "right",
          "name": "Fibula R",
          "color": null
        },
        {
          "index": 104,
          "value": 8181,
          "region": "leg",
          "anatomy": "flexor hallucis longus",
          "side": "left",
          "name": "Flexor Hallucis Longus L",
          "color": null
        },
        {
          "index": 105,
          "value": 8182,
          "region": "leg",
          "anatomy": "flexor hallucis longus",
          "side": "right",
          "name": "Flexor Hallucis Longus R",
          "color": null
        },
        {
          "index": 106,
          "value": 8191,
          "region": "leg",
          "anatomy": "extensor digitorum / hallucis longus",
          "side": "left",
          "name": "Extensor Digitorum / Hallucis Longus L",
          "color": null
        },
        {
          "index": 107,
          "value": 8192,
          "region": "leg",
          "anatomy": "extensor digitorum / hallucis longus",
          "side": "right",
          "name": "Extensor Digitorum / Hallucis Longus R",
          "color": null
        },
        {
          "index": 108,
          "value": 8201,
          "region": "leg",
          "anatomy": "flexor digitorum longus",
          "side": "left",
          "name": "Flexor Digitorum Longus L",
          "color": null
        },
        {
          "index": 109,
          "value": 8202,
          "region": "leg",
          "anatomy": "flexor digitorum longus",
          "side": "right",
          "name": "Flexor Digitorum Longus R",
          "color": null
        },
        {
          "index": 110,
          "value": 8211,
          "region": "leg",
          "anatomy": "popliteus",
          "side": "left",
          "name": "Popliteus L",
          "color": null
        },
        {
          "index": 111,
          "value": 8212,
          "region": "leg",
          "anatomy": "popliteus",
          "side": "right",
          "name": "Popliteus R",
          "color": null
        },
        {
          "index": 112,
          "value": 8221,
          "region": "leg",
          "anatomy": "plantaris",
          "side": "left",
          "name": "Plantaris L",
          "color": null
        },
        {
          "index": 113,
          "value": 8222,
          "region": "leg",
          "anatomy": "plantaris",
          "side": "right",
          "name": "Plantaris R",
          "color": null
        }
      ]
    }
  },
  {
    "id": "abdomen",
    "name": "musclemap-abdomen.onnx",
    "filename": "musclemap-abdomen.onnx",
    "label": "Abdomen",
    "modelVersion": "0.0",
    "labelSpaceId": "musclemap-abdomen-v0.0",
    "status": "legacy",
    "legacy": true,
    "numClasses": 9,
    "roiSize": [
      128,
      128
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 9,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 2,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.5,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "19631081",
      "doi": "10.5281/zenodo.19631081",
      "configSha256": "9f284550378bf7837a98c03c717b21d8b941cec8ae8adf6a95485ea6568a68f4",
      "checkpointSha256": null,
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "a8cdbf8c2874e1a2f617ecc6695244a0810eac11",
      "url": "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap/musclemap-abdomen.onnx",
      "bytes": 38999828,
      "sha256": "f2e64dd67104422f94c29382136aa438835aaea7aadc91a917178732cfc15d41",
      "precision": "q8",
      "validationReport": "legacy-provenance-not-recorded",
      "parts": null
    },
    "labelSpace": {
      "id": "musclemap-abdomen-v0.0",
      "modelVersion": "0.0",
      "classCount": 9,
      "externalEncoding": "uint8",
      "maxExternalValue": 8,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1,
          "region": "abdomen",
          "anatomy": "multifidus",
          "side": "right",
          "name": "Multifidus R",
          "color": null
        },
        {
          "index": 2,
          "value": 2,
          "region": "abdomen",
          "anatomy": "multifidus",
          "side": "left",
          "name": "Multifidus L",
          "color": null
        },
        {
          "index": 3,
          "value": 3,
          "region": "abdomen",
          "anatomy": "erector spinae",
          "side": "right",
          "name": "Erector Spinae R",
          "color": null
        },
        {
          "index": 4,
          "value": 4,
          "region": "abdomen",
          "anatomy": "erector spinae",
          "side": "left",
          "name": "Erector Spinae L",
          "color": null
        },
        {
          "index": 5,
          "value": 5,
          "region": "abdomen",
          "anatomy": "psoas major",
          "side": "right",
          "name": "Psoas Major R",
          "color": null
        },
        {
          "index": 6,
          "value": 6,
          "region": "abdomen",
          "anatomy": "psoas major",
          "side": "left",
          "name": "Psoas Major L",
          "color": null
        },
        {
          "index": 7,
          "value": 7,
          "region": "abdomen",
          "anatomy": "quadratus lumborum",
          "side": "right",
          "name": "Quadratus Lumborum R",
          "color": null
        },
        {
          "index": 8,
          "value": 8,
          "region": "abdomen",
          "anatomy": "quadratus lumborum",
          "side": "left",
          "name": "Quadratus Lumborum L",
          "color": null
        }
      ]
    }
  },
  {
    "id": "forearm",
    "name": "musclemap-forearm.onnx",
    "filename": "musclemap-forearm.onnx",
    "label": "Forearm",
    "modelVersion": "0.0",
    "labelSpaceId": "musclemap-forearm-v0.0",
    "status": "legacy",
    "legacy": true,
    "numClasses": 6,
    "roiSize": [
      256,
      256
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 6,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 1,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.5,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "19633115",
      "doi": "10.5281/zenodo.19633115",
      "configSha256": "91958f6696386de138c83c8dd57817b229cc37490f9c9551e318e1196ce4bf42",
      "checkpointSha256": null,
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "a8cdbf8c2874e1a2f617ecc6695244a0810eac11",
      "url": "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap/musclemap-forearm.onnx",
      "bytes": 26364376,
      "sha256": "48517f2aadc19183025dfe1a1952c24ae79d9a33fa5dd8154b46cf47fd87d3dd",
      "precision": "q8",
      "validationReport": "legacy-provenance-not-recorded",
      "parts": null
    },
    "labelSpace": {
      "id": "musclemap-forearm-v0.0",
      "modelVersion": "0.0",
      "classCount": 6,
      "externalEncoding": "uint8",
      "maxExternalValue": 5,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1,
          "region": "leg",
          "anatomy": "other muscles",
          "side": "no side",
          "name": "Other Muscles",
          "color": null
        },
        {
          "index": 2,
          "value": 2,
          "region": "leg",
          "anatomy": "radius",
          "side": "no side",
          "name": "Radius",
          "color": null
        },
        {
          "index": 3,
          "value": 3,
          "region": "leg",
          "anatomy": "ulna",
          "side": "no side",
          "name": "Ulna",
          "color": null
        },
        {
          "index": 4,
          "value": 4,
          "region": "leg",
          "anatomy": "extensor compartment",
          "side": "no side",
          "name": "Extensor Compartment",
          "color": null
        },
        {
          "index": 5,
          "value": 5,
          "region": "leg",
          "anatomy": "flexor compartment",
          "side": "no side",
          "name": "Flexor Compartment",
          "color": null
        }
      ]
    }
  },
  {
    "id": "leg",
    "name": "musclemap-leg.onnx",
    "filename": "musclemap-leg.onnx",
    "label": "Leg",
    "modelVersion": "0.0",
    "labelSpaceId": "musclemap-leg-v0.0",
    "status": "legacy",
    "legacy": true,
    "numClasses": 15,
    "roiSize": [
      128,
      128
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 15,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 2,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.5,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "19633057",
      "doi": "10.5281/zenodo.19633057",
      "configSha256": "d62a6810ee056fb7cb239cac5cfdec981330756bc99fe9d162a7b7f9f50fbd8c",
      "checkpointSha256": null,
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "a8cdbf8c2874e1a2f617ecc6695244a0810eac11",
      "url": "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap/musclemap-leg.onnx",
      "bytes": 39028867,
      "sha256": "3ad1c902998849ea66942863d157e1f8e608fb2c9d6b3230ee56de0e0840bcb4",
      "precision": "q8",
      "validationReport": "legacy-provenance-not-recorded",
      "parts": null
    },
    "labelSpace": {
      "id": "musclemap-leg-v0.0",
      "modelVersion": "0.0",
      "classCount": 15,
      "externalEncoding": "uint8",
      "maxExternalValue": 14,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1,
          "region": "leg",
          "anatomy": "anterior compartment",
          "side": "left",
          "name": "Anterior Compartment L",
          "color": null
        },
        {
          "index": 2,
          "value": 2,
          "region": "leg",
          "anatomy": "anterior compartment",
          "side": "right",
          "name": "Anterior Compartment R",
          "color": null
        },
        {
          "index": 3,
          "value": 3,
          "region": "leg",
          "anatomy": "deep posterior compartment",
          "side": "left",
          "name": "Deep Posterior Compartment L",
          "color": null
        },
        {
          "index": 4,
          "value": 4,
          "region": "leg",
          "anatomy": "deep posterior compartment",
          "side": "right",
          "name": "Deep Posterior Compartment R",
          "color": null
        },
        {
          "index": 5,
          "value": 5,
          "region": "leg",
          "anatomy": "lateral compartment",
          "side": "left",
          "name": "Lateral Compartment L",
          "color": null
        },
        {
          "index": 6,
          "value": 6,
          "region": "leg",
          "anatomy": "lateral compartment",
          "side": "right",
          "name": "Lateral Compartment R",
          "color": null
        },
        {
          "index": 7,
          "value": 7,
          "region": "leg",
          "anatomy": "soleus",
          "side": "left",
          "name": "Soleus L",
          "color": null
        },
        {
          "index": 8,
          "value": 8,
          "region": "leg",
          "anatomy": "soleus",
          "side": "right",
          "name": "Soleus R",
          "color": null
        },
        {
          "index": 9,
          "value": 9,
          "region": "leg",
          "anatomy": "gastrocnemius",
          "side": "left",
          "name": "Gastrocnemius L",
          "color": null
        },
        {
          "index": 10,
          "value": 10,
          "region": "leg",
          "anatomy": "gastrocnemius",
          "side": "right",
          "name": "Gastrocnemius R",
          "color": null
        },
        {
          "index": 11,
          "value": 11,
          "region": "leg",
          "anatomy": "tibia",
          "side": "left",
          "name": "Tibia L",
          "color": null
        },
        {
          "index": 12,
          "value": 12,
          "region": "leg",
          "anatomy": "tibia",
          "side": "right",
          "name": "Tibia R",
          "color": null
        },
        {
          "index": 13,
          "value": 13,
          "region": "leg",
          "anatomy": "fibula",
          "side": "left",
          "name": "Fibula L",
          "color": null
        },
        {
          "index": 14,
          "value": 14,
          "region": "leg",
          "anatomy": "fibula",
          "side": "right",
          "name": "Fibula R",
          "color": null
        }
      ]
    }
  },
  {
    "id": "pelvis",
    "name": "musclemap-pelvis.onnx",
    "filename": "musclemap-pelvis.onnx",
    "label": "Pelvis",
    "modelVersion": "0.0",
    "labelSpaceId": "musclemap-pelvis-v0.0",
    "status": "legacy",
    "legacy": true,
    "numClasses": 14,
    "roiSize": [
      128,
      128
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 14,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 2,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.5,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "19632902",
      "doi": "10.5281/zenodo.19632902",
      "configSha256": "78d225099a67b8c225cc8f35b4bd1137e861a4db84a91924b4ca74b457070a89",
      "checkpointSha256": null,
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "a8cdbf8c2874e1a2f617ecc6695244a0810eac11",
      "url": "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap/musclemap-pelvis.onnx",
      "bytes": 39023986,
      "sha256": "34babe3b30a587dc4f67f44da44a6f89f7f66dcd2d128351ecf9356cbc0c32e4",
      "precision": "q8",
      "validationReport": "legacy-provenance-not-recorded",
      "parts": null
    },
    "labelSpace": {
      "id": "musclemap-pelvis-v0.0",
      "modelVersion": "0.0",
      "classCount": 14,
      "externalEncoding": "uint8",
      "maxExternalValue": 13,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1,
          "region": "pelvis",
          "anatomy": "gluteus minimus",
          "side": "left",
          "name": "Gluteus Minimus L",
          "color": null
        },
        {
          "index": 2,
          "value": 2,
          "region": "pelvis",
          "anatomy": "gluteus minimus",
          "side": "right",
          "name": "Gluteus Minimus R",
          "color": null
        },
        {
          "index": 3,
          "value": 3,
          "region": "pelvis",
          "anatomy": "gluteus medius",
          "side": "left",
          "name": "Gluteus Medius L",
          "color": null
        },
        {
          "index": 4,
          "value": 4,
          "region": "pelvis",
          "anatomy": "gluteus medius",
          "side": "right",
          "name": "Gluteus Medius R",
          "color": null
        },
        {
          "index": 5,
          "value": 5,
          "region": "pelvis",
          "anatomy": "gluteus maximus",
          "side": "left",
          "name": "Gluteus Maximus L",
          "color": null
        },
        {
          "index": 6,
          "value": 6,
          "region": "pelvis",
          "anatomy": "gluteus maximus",
          "side": "right",
          "name": "Gluteus Maximus R",
          "color": null
        },
        {
          "index": 7,
          "value": 7,
          "region": "pelvis",
          "anatomy": "tensor fasciae latae",
          "side": "left",
          "name": "Tensor Fasciae Latae L",
          "color": null
        },
        {
          "index": 8,
          "value": 8,
          "region": "pelvis",
          "anatomy": "tensor fasciae latae",
          "side": "right",
          "name": "Tensor Fasciae Latae R",
          "color": null
        },
        {
          "index": 9,
          "value": 9,
          "region": "pelvis",
          "anatomy": "femur",
          "side": "left",
          "name": "Femur L",
          "color": null
        },
        {
          "index": 10,
          "value": 10,
          "region": "pelvis",
          "anatomy": "femur",
          "side": "right",
          "name": "Femur R",
          "color": null
        },
        {
          "index": 11,
          "value": 11,
          "region": "pelvis",
          "anatomy": "pelvic girdle",
          "side": "left",
          "name": "Pelvic Girdle L",
          "color": null
        },
        {
          "index": 12,
          "value": 12,
          "region": "pelvis",
          "anatomy": "pelvic girdle",
          "side": "right",
          "name": "Pelvic Girdle R",
          "color": null
        },
        {
          "index": 13,
          "value": 13,
          "region": "pelvis",
          "anatomy": "sacrum",
          "side": "none",
          "name": "Sacrum",
          "color": null
        }
      ]
    }
  },
  {
    "id": "thigh",
    "name": "musclemap-thigh.onnx",
    "filename": "musclemap-thigh.onnx",
    "label": "Thigh",
    "modelVersion": "0.0",
    "labelSpaceId": "musclemap-thigh-v0.0",
    "status": "legacy",
    "legacy": true,
    "numClasses": 29,
    "roiSize": [
      128,
      128
    ],
    "network": {
      "spatialDims": 2,
      "inChannels": 1,
      "outChannels": 29,
      "channels": [
        64,
        128,
        256,
        512,
        1024
      ],
      "strides": [
        2,
        2,
        2,
        2
      ],
      "numResUnits": 2,
      "activation": "LeakyReLU",
      "normalization": "instance"
    },
    "preprocessing": {
      "orientation": "RAS",
      "targetSpacing": [
        1,
        1,
        -1
      ],
      "cropForegroundMargin": 20,
      "padding": "end",
      "overlapDefault": 0.5,
      "normalization": "nonzero-zscore"
    },
    "source": {
      "record": "19633000",
      "doi": "10.5281/zenodo.19633000",
      "configSha256": "9d123314d744d21a0c6b8727479771c5fba43a564613bee3d72ec59de1c73025",
      "checkpointSha256": null,
      "upstreamRevision": "6e1e1eb6732337c13cab53bd5cc800c69024774f",
      "license": "MIT"
    },
    "asset": {
      "revision": "a8cdbf8c2874e1a2f617ecc6695244a0810eac11",
      "url": "https://huggingface.co/datasets/sbollmann/neurodesk-webapps-assets/resolve/a8cdbf8c2874e1a2f617ecc6695244a0810eac11/musclemap/musclemap-thigh.onnx",
      "bytes": 39099153,
      "sha256": "2d1a607adfa0758516069e039717079a2340811e3d3c70a7e9621aa1564399f2",
      "precision": "q8",
      "validationReport": "legacy-provenance-not-recorded",
      "parts": null
    },
    "labelSpace": {
      "id": "musclemap-thigh-v0.0",
      "modelVersion": "0.0",
      "classCount": 29,
      "externalEncoding": "uint8",
      "maxExternalValue": 28,
      "labels": [
        {
          "index": 0,
          "value": 0,
          "region": "",
          "anatomy": "background",
          "side": "none",
          "name": "Background",
          "color": [
            0,
            0,
            0,
            0
          ]
        },
        {
          "index": 1,
          "value": 1,
          "region": "thigh",
          "anatomy": "vastus lateralis",
          "side": "left",
          "name": "Vastus Lateralis L",
          "color": null
        },
        {
          "index": 2,
          "value": 2,
          "region": "thigh",
          "anatomy": "vastus lateralis",
          "side": "right",
          "name": "Vastus Lateralis R",
          "color": null
        },
        {
          "index": 3,
          "value": 3,
          "region": "thigh",
          "anatomy": "vastus intermedius",
          "side": "left",
          "name": "Vastus Intermedius L",
          "color": null
        },
        {
          "index": 4,
          "value": 4,
          "region": "thigh",
          "anatomy": "vastus intermedius",
          "side": "right",
          "name": "Vastus Intermedius R",
          "color": null
        },
        {
          "index": 5,
          "value": 5,
          "region": "thigh",
          "anatomy": "vastus medialis",
          "side": "left",
          "name": "Vastus Medialis L",
          "color": null
        },
        {
          "index": 6,
          "value": 6,
          "region": "thigh",
          "anatomy": "vastus medialis",
          "side": "right",
          "name": "Vastus Medialis R",
          "color": null
        },
        {
          "index": 7,
          "value": 7,
          "region": "thigh",
          "anatomy": "rectus femoris",
          "side": "left",
          "name": "Rectus Femoris L",
          "color": null
        },
        {
          "index": 8,
          "value": 8,
          "region": "thigh",
          "anatomy": "rectus femoris",
          "side": "right",
          "name": "Rectus Femoris R",
          "color": null
        },
        {
          "index": 9,
          "value": 9,
          "region": "thigh",
          "anatomy": "sartorius",
          "side": "left",
          "name": "Sartorius L",
          "color": null
        },
        {
          "index": 10,
          "value": 10,
          "region": "thigh",
          "anatomy": "sartorius",
          "side": "right",
          "name": "Sartorius R",
          "color": null
        },
        {
          "index": 11,
          "value": 11,
          "region": "thigh",
          "anatomy": "gracilis",
          "side": "left",
          "name": "Gracilis L",
          "color": null
        },
        {
          "index": 12,
          "value": 12,
          "region": "thigh",
          "anatomy": "gracilis",
          "side": "right",
          "name": "Gracilis R",
          "color": null
        },
        {
          "index": 13,
          "value": 13,
          "region": "thigh",
          "anatomy": "semimembranosus",
          "side": "left",
          "name": "Semimembranosus L",
          "color": null
        },
        {
          "index": 14,
          "value": 14,
          "region": "thigh",
          "anatomy": "semimembranosus",
          "side": "right",
          "name": "Semimembranosus R",
          "color": null
        },
        {
          "index": 15,
          "value": 15,
          "region": "thigh",
          "anatomy": "semitendinosus",
          "side": "left",
          "name": "Semitendinosus L",
          "color": null
        },
        {
          "index": 16,
          "value": 16,
          "region": "thigh",
          "anatomy": "semitendinosus",
          "side": "right",
          "name": "Semitendinosus R",
          "color": null
        },
        {
          "index": 17,
          "value": 17,
          "region": "thigh",
          "anatomy": "biceps femoris long head",
          "side": "left",
          "name": "Biceps Femoris Long Head L",
          "color": null
        },
        {
          "index": 18,
          "value": 18,
          "region": "thigh",
          "anatomy": "biceps femoris long head",
          "side": "right",
          "name": "Biceps Femoris Long Head R",
          "color": null
        },
        {
          "index": 19,
          "value": 19,
          "region": "thigh",
          "anatomy": "biceps femoris short head",
          "side": "left",
          "name": "Biceps Femoris Short Head L",
          "color": null
        },
        {
          "index": 20,
          "value": 20,
          "region": "thigh",
          "anatomy": "biceps femoris short head",
          "side": "right",
          "name": "Biceps Femoris Short Head R",
          "color": null
        },
        {
          "index": 21,
          "value": 21,
          "region": "thigh",
          "anatomy": "adductor magnus",
          "side": "left",
          "name": "Adductor Magnus L",
          "color": null
        },
        {
          "index": 22,
          "value": 22,
          "region": "thigh",
          "anatomy": "adductor magnus",
          "side": "right",
          "name": "Adductor Magnus R",
          "color": null
        },
        {
          "index": 23,
          "value": 23,
          "region": "thigh",
          "anatomy": "adductor longus",
          "side": "left",
          "name": "Adductor Longus L",
          "color": null
        },
        {
          "index": 24,
          "value": 24,
          "region": "thigh",
          "anatomy": "adductor longus",
          "side": "right",
          "name": "Adductor Longus R",
          "color": null
        },
        {
          "index": 25,
          "value": 25,
          "region": "thigh",
          "anatomy": "adductor brevis",
          "side": "left",
          "name": "Adductor Brevis L",
          "color": null
        },
        {
          "index": 26,
          "value": 26,
          "region": "thigh",
          "anatomy": "adductor brevis",
          "side": "right",
          "name": "Adductor Brevis R",
          "color": null
        },
        {
          "index": 27,
          "value": 27,
          "region": "thigh",
          "anatomy": "femur",
          "side": "left",
          "name": "Femur L",
          "color": null
        },
        {
          "index": 28,
          "value": 28,
          "region": "thigh",
          "anatomy": "femur",
          "side": "right",
          "name": "Femur R",
          "color": null
        }
      ]
    }
  }
];

export const MODELS = MODEL_RELEASES
  .filter(model => model.status === 'active' || model.status === 'legacy')
  .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'));
export const LABEL_SPACES = Object.fromEntries(MODEL_RELEASES.map(model => [model.labelSpaceId, model.labelSpace]));
export const MODELS_BY_LABEL_SPACE = Object.fromEntries(MODELS.map(model => [model.labelSpaceId, model]));
export const MODELS_BY_ID = Object.fromEntries([...MODELS].reverse().map(model => [model.id, model]));
export const MODELS_BY_FILENAME = Object.fromEntries([...MODELS].reverse().map(model => [model.filename, model]));

export function getModelById(id) { return MODELS_BY_ID[id] || null; }
export function getModelByFilename(filename) { return MODELS_BY_FILENAME[filename] || null; }
export function getModelByLabelSpace(id) { return MODELS_BY_LABEL_SPACE[id] || null; }
export function getLabelSpace(id) { return LABEL_SPACES[id] || null; }
export function requireLabelSpace(id) {
  const labelSpace = getLabelSpace(id);
  if (!labelSpace) throw new Error(`Unknown MuscleMap label space: ${id}`);
  return labelSpace;
}
