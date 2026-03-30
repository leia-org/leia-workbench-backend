import RunnerService from '../../services/v1/RunnerService.js';

export const getRunnerModels = async (req, res, next) => {
  try {
    const models = await RunnerService.getRunnerModels();
    res.json({ models });
  } catch (error) {
    next(error);
  }
};
