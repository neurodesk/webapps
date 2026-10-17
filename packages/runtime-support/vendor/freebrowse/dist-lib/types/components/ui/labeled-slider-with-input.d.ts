import * as React from "react";
export interface LabeledSliderWithInputProps {
    label: string;
    value: number;
    onValueChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    decimalPlaces?: number;
    className?: string;
    disabled?: boolean;
}
declare const LabeledSliderWithInput: React.ForwardRefExoticComponent<LabeledSliderWithInputProps & React.RefAttributes<HTMLDivElement>>;
export { LabeledSliderWithInput };
