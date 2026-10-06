% input.m
% Answers the one question io_loadRFwaveform asks of a phase-modulated
% (adiabatic) pulse, "Input desired w1max in kHz (for 5.00 ms pulse)", from
% the environment, so shaped simulations run unattended. sim_shaped.m puts
% this directory on the path and sets FIDA_W1MAX_KHZ from library.json.
function v = input(prompt, varargin)
  v = str2double(getenv('FIDA_W1MAX_KHZ'));
  if isnan(v)
    error('input: set FIDA_W1MAX_KHZ to answer "%s"', prompt);
  end
end
