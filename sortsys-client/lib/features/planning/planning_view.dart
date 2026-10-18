import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../domain/planning.dart';

enum PlanningView { day, week }

const defaultPlanningView = PlanningView.week;

typedef PlanningRange = ({DateTime from, DateTime toExclusive});

PlanningRange planningViewRange(DateTime day, PlanningView view) {
  final week = view == PlanningView.week;
  final from = week ? monday(day) : startOfDay(day);
  final to = shiftDay(from, week ? 7 : 1);

  return (from: from, toExclusive: to);
}

api_models.ProjectsDeploymentsListInput planningListInput(
  PlanningRange range, {
  required String userId,
  required bool canViewAll,
}) {
  final user = canViewAll
      ? const RpcOptional<String>.absent()
      : RpcOptional.value(userId);

  return api_models.ProjectsDeploymentsListInput(
    from: range.from,
    to: range.toExclusive,
    userId: user,
  );
}
