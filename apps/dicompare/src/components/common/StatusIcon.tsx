import React from 'react';
import { CheckCircle, XCircle, AlertTriangle, HelpCircle } from 'lucide-react';
import { ComplianceFieldResult } from '../../types/schema';

interface StatusIconProps {
  status: ComplianceFieldResult['status'];
  className?: string;
}

export const StatusIcon: React.FC<StatusIconProps> = ({ status, className = "h-4 w-4" }) => {
  switch (status) {
    case 'pass':
      return <CheckCircle className={`${className} text-green-600`} />;
    case 'fail':
      return <XCircle className={`${className} text-red-600`} />;
    case 'warning':
      return <AlertTriangle className={`${className} text-yellow-600`} />;
    case 'na':
      return <HelpCircle className={`${className} text-gray-500`} />;
    case 'unknown':
    default:
      return <HelpCircle className={`${className} text-gray-400`} />;
  }
};

export default StatusIcon;
