const CSV_HEADER = 'network,voxelsInLesion,fractionOfLesion,voxelsInNetwork,fractionOfNetwork,parcels';

function orderedNetworks(summary) {
  const networks = Array.isArray(summary?.networks) ? summary.networks : [];
  return networks
    .filter(row => row.network !== 'Unassigned')
    .concat(networks.filter(row => row.network === 'Unassigned'));
}

function formatInt(value) {
  return `${Math.trunc(Number(value) || 0)}`;
}

function formatFraction(value) {
  return (Number(value) || 0).toFixed(4);
}

export function serializeOverlapCsv(summary, options = {}) {
  const networkSizes = options.networkSizes || {};
  const lines = [CSV_HEADER];

  for (const row of orderedNetworks(summary)) {
    const hasNetworkSize = Object.prototype.hasOwnProperty.call(networkSizes, row.network);
    const voxelsInNetwork = hasNetworkSize ? Number(networkSizes[row.network]) || 0 : null;
    const fractionOfNetwork = hasNetworkSize && voxelsInNetwork > 0
      ? row.voxelsInLesion / voxelsInNetwork
      : 0;
    const parcels = Array.isArray(row.parcels) ? row.parcels.join(';') : '';

    lines.push([
      row.network,
      formatInt(row.voxelsInLesion),
      formatFraction(row.fractionOfLesion),
      hasNetworkSize ? formatInt(voxelsInNetwork) : '',
      hasNetworkSize ? formatFraction(fractionOfNetwork) : '',
      parcels
    ].join(','));
  }

  return `${lines.join('\n')}\n`;
}
