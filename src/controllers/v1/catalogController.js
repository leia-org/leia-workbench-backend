import CatalogService from '../../services/v1/CatalogService.js';

export const getAllExperiments = async (req, res, next) => {
  try {
    const experiments = await CatalogService.findAllExperiments();
    res.status(200).json(experiments);
  } catch (error) {
    next(error);
  }
};

export const getExperimentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const experiment = await CatalogService.findExperimentById(id);
    res.status(200).json(experiment);
  } catch (error) {
    next(error);
  }
};
