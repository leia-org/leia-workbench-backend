export const checkSecret = async (req, res, next) => {
  try {
    const { secret } = req.body;
    if (!secret) {
      return res.status(400).json({ message: 'Secret is required' });
    }

    if (process.env.ADMIN_SECRET !== secret) {
      return res.status(403).json({ message: 'Invalid secret' });
    }

    res.status(200).json({ message: 'Secret is valid' });
  } catch (error) {
    next(error);
  }
};
